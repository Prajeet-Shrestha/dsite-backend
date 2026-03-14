// ── Deployments Routes ──
const { Router } = require('express');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const queue = require('../queue');
const github = require('../services/github');

const router = Router();

/**
 * POST /api/projects/:projectId/deploy — Trigger a manual deployment
 */
router.post('/projects/:projectId/deploy', requireAuth, async (req, res, next) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
      .get(req.params.projectId, req.user.id);

    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Rate limit: reject if already building/queued (W3)
    const existing = db.prepare(`
      SELECT id FROM deployments
      WHERE project_id = ? AND status IN ('queued', 'building', 'deploying')
    `).get(project.id);

    if (existing) {
      return res.status(429).json({
        error: 'A deployment is already in progress',
        deploymentId: existing.id,
      });
    }

    // Fetch latest commit
    const [owner, repo] = project.repo_full_name.split('/');
    let commitSha = null;
    let commitMessage = 'Manual deploy';
    try {
      const commit = await github.getLatestCommit(req.user.token, owner, repo, project.branch);
      commitSha = commit.sha;
      commitMessage = commit.message;
    } catch (err) {
      console.warn('Failed to fetch latest commit:', err.message);
    }

    // Create deployment
    const deploymentId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO deployments (id, project_id, commit_sha, commit_message, status, trigger_type)
      VALUES (?, ?, ?, ?, 'queued', 'manual')
    `).run(deploymentId, project.id, commitSha, commitMessage);

    // Kick off build (async — don't await)
    queue.addBuild(project, deploymentId, req.user.token);

    const deployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(deploymentId);
    res.status(201).json({ deployment });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/deployments/:id — Deployment detail
 */
router.get('/deployments/:id', requireAuth, (req, res) => {
  const deployment = db.prepare(`
    SELECT d.*, p.user_id FROM deployments d
    JOIN projects p ON p.id = d.project_id
    WHERE d.id = ?
  `).get(req.params.id);

  if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
  if (deployment.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  delete deployment.user_id;
  res.json({ deployment });
});

/**
 * GET /api/deployments/:id/logs — SSE build log stream
 *
 * SSE Event Contract (S1):
 *   data: <line>\n\n                                — Log line (unnamed = onmessage)
 *   event: status\ndata: building\n\n                — Status change
 *   event: build_error\ndata: <msg>\n\n              — Error message (V5)
 *   event: done\ndata: ok\n\n                        — Stream complete
 *   id: <num>\n                                      — For Last-Event-ID
 *   :heartbeat\n\n                                   — Keep-alive (comment)
 *   retry: 5000\n                                    — Reconnect interval
 */
router.get('/deployments/:id/logs', requireAuth, (req, res) => {
  const deployment = db.prepare(`
    SELECT d.*, p.user_id FROM deployments d
    JOIN projects p ON p.id = d.project_id
    WHERE d.id = ?
  `).get(req.params.id);

  if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
  if (deployment.user_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });

  // ── SSE headers ──
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write('retry: 5000\n');

  const lastEventId = parseInt(req.headers['last-event-id']) || 0;
  let lineNum = 0;

  // Helper: send SSE line
  const sendLine = (line) => {
    lineNum++;
    if (lineNum <= lastEventId) return; // Skip already-sent (J3)
    res.write(`id: ${lineNum}\ndata: ${line}\n\n`);
  };

  const sendStatus = (status) => {
    res.write(`event: status\ndata: ${status}\n\n`);
  };

  const sendError = (msg) => {
    res.write(`event: build_error\ndata: ${msg}\n\n`);
  };

  const sendDone = () => {
    res.write('event: done\ndata: ok\n\n');
    res.end();
  };

  // ── If deployment is already complete, replay stored logs ──
  if (['live', 'failed', 'cancelled'].includes(deployment.status)) {
    if (deployment.logs) {
      const lines = deployment.logs.split('\n');
      for (const line of lines) {
        sendLine(line);
      }
    }
    sendStatus(deployment.status);
    if (deployment.status === 'failed' && deployment.error_message) {
      sendError(deployment.error_message);
    }
    sendDone();
    return;
  }

  // ── Active build — stream live ──
  const emitter = queue.getEmitter(req.params.id);

  // Replay any buffered lines first
  // (these come from logBuffers in queue.js)

  const onLog = (line) => sendLine(line);
  const onStatus = (status) => sendStatus(status);
  const onBuildError = (msg) => sendError(msg);
  const onDone = () => {
    cleanup();
    sendDone();
  };

  emitter.on('log', onLog);
  emitter.on('status', onStatus);
  emitter.on('build_error', onBuildError);
  emitter.on('done', onDone);

  // Heartbeat every 15s
  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 15000);

  // Cleanup on client disconnect
  const cleanup = () => {
    clearInterval(heartbeat);
    emitter.off('log', onLog);
    emitter.off('status', onStatus);
    emitter.off('build_error', onBuildError);
    emitter.off('done', onDone);
  };

  req.on('close', cleanup);
});

module.exports = router;
