// ── Build Queue & Orchestrator ──
// Owns the full build lifecycle: queue → build → deploy → status updates
const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const { buildsDir } = require('./db');
const builder = require('./services/builder');
const deployer = require('./services/deployer');
const github = require('./services/github');
const siteCache = require('./services/siteCache');

// ── Config ──
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_BUILDS) || 2;
const BUILD_TIMEOUT = parseInt(process.env.BUILD_TIMEOUT_MS) || 600000;
const DEPLOY_TIMEOUT = parseInt(process.env.DEPLOY_TIMEOUT_MS) || 600000;

// ── State ──
const projectState = new Map();   // projectId → { active, pending }
const emitters = new Map();       // deploymentId → EventEmitter
const logBuffers = new Map();     // deploymentId → { lines: [], interval }

// ── Semaphore (abort-aware) ──
let activeSlots = 0;
const waitQueue = [];

function semaphoreAcquire(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));

    if (activeSlots < MAX_CONCURRENT) {
      activeSlots++;
      return resolve();
    }

    const entry = { resolve, reject };
    waitQueue.push(entry);

    const onAbort = () => {
      const idx = waitQueue.indexOf(entry);
      if (idx !== -1) waitQueue.splice(idx, 1);
      reject(new Error('Aborted'));
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
      // Clean up listener when resolved normally
      const origResolve = entry.resolve;
      entry.resolve = () => {
        signal.removeEventListener('abort', onAbort);
        origResolve();
      };
    }
  });
}

function semaphoreRelease() {
  if (waitQueue.length > 0) {
    const next = waitQueue.shift();
    next.resolve();
  } else {
    activeSlots = Math.max(0, activeSlots - 1);
  }
}

// ── Deploy Mutex (serialize site-builder calls) ──
let deployLock = Promise.resolve();
function withDeployLock(fn) {
  const p = deployLock.then(fn, fn);
  deployLock = p.catch(() => {});
  return p;
}

// ── Emitter Management ──
function getEmitter(deploymentId) {
  if (!emitters.has(deploymentId)) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);
    emitters.set(deploymentId, emitter);
  }
  return emitters.get(deploymentId);
}

function cleanupEmitter(deploymentId) {
  // Delay cleanup to allow SSE clients to receive final events
  setTimeout(() => {
    const emitter = emitters.get(deploymentId);
    if (emitter) {
      emitter.removeAllListeners();
      emitters.delete(deploymentId);
    }
    const buf = logBuffers.get(deploymentId);
    if (buf) {
      if (buf.interval) clearInterval(buf.interval);
      logBuffers.delete(deploymentId);
    }
  }, 30000);
}

// ── Log Batching ──
function startLogBatching(deploymentId) {
  const buf = { lines: [], interval: null };
  buf.interval = setInterval(() => flushLogs(deploymentId), 500);
  logBuffers.set(deploymentId, buf);
  return buf;
}

function appendLog(deploymentId, line) {
  const buf = logBuffers.get(deploymentId);
  if (buf) buf.lines.push(line);
}

function flushLogs(deploymentId) {
  const buf = logBuffers.get(deploymentId);
  if (!buf || buf.lines.length === 0) return;

  const logsText = buf.lines.join('\n');
  buf.lines = [];

  try {
    const row = db.prepare('SELECT logs FROM deployments WHERE id = ?').get(deploymentId);
    const existing = row?.logs || '';
    const updated = existing ? existing + '\n' + logsText : logsText;

    // Tail-preserving truncation: keep last 500KB (K3)
    const MAX_LOG_SIZE = 500 * 1024;
    let finalLogs = updated;
    if (finalLogs.length > MAX_LOG_SIZE) {
      finalLogs = '[Earlier output truncated]\n' + finalLogs.slice(-MAX_LOG_SIZE);
    }

    db.prepare('UPDATE deployments SET logs = ? WHERE id = ?').run(finalLogs, deploymentId);
  } catch (err) {
    console.error(`Log flush failed for ${deploymentId}:`, err.message);
  }
}

// ── Build Orchestrator ──
async function addBuild(project, deploymentId, userToken) {
  const projectId = project.id;
  const state = projectState.get(projectId) || { active: null, pending: null };
  projectState.set(projectId, state);

  // Cancel active build if exists
  if (state.active) {
    state.active.abort.abort();
  }

  // Cancel pending build if exists
  if (state.pending) {
    db.prepare('UPDATE deployments SET status = ?, completed_at = datetime(\'now\') WHERE id = ?')
      .run('cancelled', state.pending.deploymentId);
    const pendingEmitter = getEmitter(state.pending.deploymentId);
    pendingEmitter.emit('status', 'cancelled');
    pendingEmitter.emit('done');
    cleanupEmitter(state.pending.deploymentId);
  }

  // Set as pending (or active if nothing active)
  state.pending = { deploymentId, project, userToken };

  // If there's an active build, it will promote pending when done
  if (state.active) return;

  // No active build — start immediately
  await promotePending(projectId);
}

async function promotePending(projectId) {
  const state = projectState.get(projectId);
  if (!state?.pending) return;

  const { deploymentId, project, userToken } = state.pending;
  const abort = new AbortController();
  state.active = { deploymentId, abort };
  state.pending = null;

  try {
    await runPipeline(project, deploymentId, userToken, abort);
  } finally {
    state.active = null;
    // Promote next pending if exists
    if (state.pending) {
      promotePending(projectId).catch(err =>
        console.error(`Promote failed for ${projectId}:`, err.message)
      );
    } else {
      projectState.delete(projectId);
    }
  }
}

async function runPipeline(project, deploymentId, userToken, abortController) {
  const signal = abortController.signal;
  const emitter = getEmitter(deploymentId);
  const logBuf = startLogBatching(deploymentId);

  const buildDir = path.join(buildsDir, deploymentId);
  const [owner, repo] = project.repo_full_name.split('/');

  // Helper: emit log line (to SSE + buffer)
  const emitLog = (line) => {
    emitter.emit('log', line);
    appendLog(deploymentId, line);
  };

  // Helper: best-effort commit status
  const commitStatus = async (sha, state, description, url) => {
    try {
      await github.createCommitStatus(userToken, owner, repo, sha, state, description, url);
    } catch (err) {
      console.warn('Commit status failed:', err.message);
    }
  };

  // Get commit SHA for status updates
  let commitSha;
  try {
    const row = db.prepare('SELECT commit_sha FROM deployments WHERE id = ?').get(deploymentId);
    commitSha = row?.commit_sha;
  } catch (_) {}

  try {
    // ── ACQUIRE SEMAPHORE ──
    await semaphoreAcquire(signal);

    // ── BUILDING ──
    db.prepare('UPDATE deployments SET status = ?, started_at = datetime(\'now\') WHERE id = ?')
      .run('building', deploymentId);
    emitter.emit('status', 'building');
    emitLog('── Build started ──');
    if (commitSha) commitStatus(commitSha, 'pending', 'Building...');

    // Build timeout
    const buildTimeout = setTimeout(() => {
      if (!signal.aborted) {
        emitLog('⚠ Build timed out');
        abortController.abort();
      }
    }, BUILD_TIMEOUT);

    let outputDir;
    try {
      outputDir = await builder.run(project, buildDir, userToken, emitLog, signal);
    } finally {
      clearTimeout(buildTimeout);
    }

    // ── ABORT CHECK between builder and deployer (P2) ──
    if (signal.aborted) throw new Error('Aborted');

    // ── DEPLOYING ──
    db.prepare('UPDATE deployments SET status = ? WHERE id = ?').run('deploying', deploymentId);
    emitter.emit('status', 'deploying');
    emitLog('── Deploying to Walrus ──');
    if (commitSha) commitStatus(commitSha, 'pending', 'Deploying to Walrus...');

    // Deploy timeout (separate from build)
    const deployTimeout = setTimeout(() => {
      if (!signal.aborted) {
        emitLog('⚠ Deploy timed out');
        abortController.abort();
      }
    }, DEPLOY_TIMEOUT);

    let result;
    try {
      result = await withDeployLock(() => deployer.run(project, outputDir, emitLog));
    } finally {
      clearTimeout(deployTimeout);
    }

    // ── LIVE ──
    db.prepare(`
      UPDATE deployments SET status = 'live', walrus_url = ?, sui_cost = ?, wal_cost = ?, completed_at = datetime('now')
      WHERE id = ?
    `).run(result.url, result.suiCost || 0, result.walCost || 0, deploymentId);

    db.prepare('UPDATE projects SET walrus_object_id = ?, walrus_url = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(result.objectId, result.url, project.id);

    emitter.emit('status', 'live');
    emitLog(`✓ Live at ${result.url}`);
    if (project.slug) siteCache.invalidate(project.slug);
    if (commitSha) commitStatus(commitSha, 'success', `Live at ${result.url}`, result.url);

  } catch (err) {
    if (signal.aborted) {
      // ── CANCELLED ──
      db.prepare('UPDATE deployments SET status = ?, completed_at = datetime(\'now\') WHERE id = ?')
        .run('cancelled', deploymentId);
      emitter.emit('status', 'cancelled');
      emitLog('── Build cancelled ──');
      if (commitSha) commitStatus(commitSha, 'failure', 'Cancelled');
    } else {
      // ── FAILED ──
      const errorMsg = err.message || 'Unknown error';
      db.prepare('UPDATE deployments SET status = ?, error_message = ?, sui_cost = ?, completed_at = datetime(\'now\') WHERE id = ?')
        .run('failed', errorMsg, err.suiCost || 0, deploymentId);
      emitter.emit('status', 'failed');
      emitter.emit('build_error', errorMsg);
      emitLog(`✗ Failed: ${errorMsg}`);
      if (commitSha) commitStatus(commitSha, 'failure', errorMsg.slice(0, 140));
    }
  } finally {
    // ── CLEANUP ──
    flushLogs(deploymentId);
    if (logBuf.interval) clearInterval(logBuf.interval);

    // Remove build directory
    try {
      fs.rmSync(buildDir, { recursive: true, force: true });
    } catch (err) {
      console.warn(`Failed to clean build dir ${buildDir}:`, err.message);
    }

    semaphoreRelease();
    emitter.emit('done');
    cleanupEmitter(deploymentId);
  }
}

// ── Cancel ──
function cancelBuild(projectId) {
  const state = projectState.get(projectId);
  if (state?.active) {
    state.active.abort.abort();
  }
  if (state?.pending) {
    db.prepare('UPDATE deployments SET status = ?, completed_at = datetime(\'now\') WHERE id = ?')
      .run('cancelled', state.pending.deploymentId);
    const emitter = getEmitter(state.pending.deploymentId);
    emitter.emit('status', 'cancelled');
    emitter.emit('done');
    cleanupEmitter(state.pending.deploymentId);
    state.pending = null;
  }
}

// ── Startup: mark interrupted builds as failed (H1) ──
function markInterruptedBuilds() {
  const result = db.prepare(`
    UPDATE deployments SET status = 'failed', error_message = 'Server restarted', completed_at = datetime('now')
    WHERE status IN ('building', 'deploying', 'queued')
  `).run();
  if (result.changes > 0) {
    console.log(`Marked ${result.changes} interrupted build(s) as failed`);
  }
}

// ── SSE helpers ──
function getActiveBuilds() {
  return Array.from(projectState.entries())
    .filter(([_, s]) => s.active)
    .map(([id, s]) => ({ projectId: id, deploymentId: s.active.deploymentId }));
}

module.exports = {
  addBuild,
  cancelBuild,
  getEmitter,
  markInterruptedBuilds,
  getActiveBuilds,
};
