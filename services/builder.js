// ── Builder Service ──
// Clone → Install → Build pipeline
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Mnemonic for sanitization (full string only — AA3)
const ADMIN_MNEMONIC = process.env.ADMIN_MNEMONICS || '';

/**
 * Sanitize log lines: strip tokens and mnemonic
 */
function sanitize(text) {
  // Strip GitHub tokens from clone URLs
  let clean = text.replace(/x-access-token:[^@]+@/gi, 'x-access-token:***@');
  // Strip full mnemonic string if it appears
  if (ADMIN_MNEMONIC) {
    clean = clean.replaceAll(ADMIN_MNEMONIC, '[REDACTED_MNEMONIC]');
  }
  return clean;
}

/**
 * Run a command, pipe output through sanitizer to emitter/log, respect abort signal.
 * Returns a promise that resolves on exit code 0, rejects otherwise.
 */
function runCommand(cmd, args, opts, emitLog, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Aborted'));

    const child = spawn(cmd, args, {
      ...opts,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let killed = false;

    const onAbort = () => {
      killed = true;
      try {
        // Kill process group (detached)
        process.kill(-child.pid, 'SIGTERM');
      } catch (_) {
        try { child.kill('SIGTERM'); } catch (__) {}
      }
      // Force kill after 5s
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {
          try { child.kill('SIGKILL'); } catch (__) {}
        }
      }, 5000);
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        emitLog(sanitize(line));
      }
    });

    child.stderr.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        emitLog(sanitize(line));
      }
    });

    child.on('close', (code) => {
      // FD cleanup (V6)
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();

      if (signal) signal.removeEventListener('abort', onAbort);

      if (killed) return reject(new Error('Aborted'));
      if (code !== 0) return reject(new Error(`Process exited with code ${code}`));
      resolve();
    });

    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

/**
 * Detect package manager from lockfiles.
 */
function detectPackageManager(dir) {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lockb'))) return 'bun';
  return 'npm';
}

/**
 * Get install command for package manager.
 */
function getInstallCmd(pm) {
  switch (pm) {
    case 'pnpm': return ['pnpm', ['install', '--frozen-lockfile']];
    case 'yarn': return ['yarn', ['install', '--frozen-lockfile']];
    case 'bun':  return ['bun', ['install', '--frozen-lockfile']];
    default:     return ['npm', ['ci']];
  }
}

/**
 * Main builder entry point.
 *
 * @param {Object} project - Project config from DB
 * @param {string} buildDir - Ephemeral work directory
 * @param {string} token - GitHub access token
 * @param {Function} emitLog - fn(line) to emit log lines
 * @param {AbortSignal} signal - Abort signal
 * @returns {string} Absolute path to validated build output directory
 */
async function run(project, buildDir, token, emitLog, signal) {
  // ── Clean/create build directory (C8) ──
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });

  // ── Disk space check (I9) ──
  try {
    const stats = fs.statfsSync(buildDir);
    const freeGB = (stats.bavail * stats.bsize) / (1024 ** 3);
    if (freeGB < 1) {
      throw new Error(`Insufficient disk space: ${freeGB.toFixed(1)}GB free (need ≥1GB)`);
    }
  } catch (err) {
    if (err.message.includes('Insufficient disk')) throw err;
    // statfsSync may not exist on all platforms — continue
  }

  // ── 1. GIT CLONE ──
  emitLog(`Cloning ${project.repo_full_name}@${project.branch}...`);

  // URL constructed server-side (I6)
  const cloneUrl = `https://x-access-token:${token}@github.com/${project.repo_full_name}.git`;

  try {
    await runCommand('git', [
      '-c', 'core.symlinks=false',           // Symlink protection (N1)
      'clone', '--depth', '1',
      '--branch', project.branch,
      cloneUrl, '.',
    ], {
      cwd: buildDir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },  // No prompts (C7)
    }, emitLog, signal);
  } catch (err) {
    // Classify git clone errors
    const msg = err.message || '';
    if (msg.includes('could not read Username') || msg.includes('Authentication failed') || msg.includes('403')) {
      throw new Error('Git clone failed: authentication error — check repository access');
    }
    if (msg.includes('Remote branch') && msg.includes('not found')) {
      throw new Error(`Git clone failed: branch "${project.branch}" not found`);
    }
    if (msg.includes('Could not resolve host')) {
      throw new Error('Git clone failed: network error — cannot reach GitHub');
    }
    throw new Error(`Git clone failed: ${sanitize(msg)}`);
  }

  emitLog('✓ Clone complete');

  // ── 2. READ CONFIG ──
  let rootDir = project.root_directory || '';
  let buildCommand = project.build_command || '';
  let outputDirectory = project.output_directory || '';

  // Check for dsite.json in repo root
  const dsiteConfigPath = path.join(buildDir, 'dsite.json');
  if (fs.existsSync(dsiteConfigPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(dsiteConfigPath, 'utf8'));
      emitLog(`Found dsite.json: ${JSON.stringify(config)}`);
      // Project DB settings take precedence, dsite.json as fallback
      if (!buildCommand && config.buildCommand) buildCommand = config.buildCommand;
      if (!outputDirectory && config.outputDirectory) outputDirectory = config.outputDirectory;
      if (!rootDir && config.rootDirectory) rootDir = config.rootDirectory;
    } catch (err) {
      emitLog(`Warning: failed to parse dsite.json: ${err.message}`);
    }
  }

  // ── rootDirectory containment check (I1) ──
  let workDir = buildDir;
  if (rootDir) {
    workDir = path.resolve(buildDir, rootDir);
    if (!workDir.startsWith(buildDir)) {
      throw new Error(`Security: rootDirectory "${rootDir}" escapes build directory`);
    }
    if (!fs.existsSync(workDir)) {
      throw new Error(`rootDirectory "${rootDir}" does not exist in repository`);
    }
  }

  // ── 3. INSTALL DEPENDENCIES ──
  const hasPackageJson = fs.existsSync(path.join(workDir, 'package.json'));
  if (hasPackageJson) {
    const pm = detectPackageManager(workDir);
    const [cmd, args] = getInstallCmd(pm);
    emitLog(`Installing dependencies with ${pm}...`);

    // Add node_modules/.bin to PATH (C6)
    const binPath = path.join(workDir, 'node_modules', '.bin');
    const envPath = `${binPath}:${process.env.PATH}`;

    // Strip NODE_ENV=production so devDependencies (vite, tsc, etc.) are installed
    const installEnv = { ...process.env, PATH: envPath };
    delete installEnv.NODE_ENV;

    try {
      await runCommand(cmd, args, {
        cwd: workDir,
        env: installEnv,
      }, emitLog, signal);
    } catch (err) {
      throw new Error(`Dependency install failed: ${sanitize(err.message)}`);
    }
    emitLog('✓ Dependencies installed');
  } else {
    emitLog('No package.json found, skipping install');
  }

  // ── 4. BUILD ──
  if (buildCommand) {
    emitLog(`Running build: ${buildCommand}`);

    // Inject project env vars (strip NODE_ENV so build tools like vite work)
    let buildEnv = { ...process.env };
    delete buildEnv.NODE_ENV;
    if (project.env_vars) {
      try {
        const { decrypt } = require('../crypto');
        const decrypted = decrypt(project.env_vars);
        if (decrypted) {
          const vars = JSON.parse(decrypted);
          buildEnv = { ...buildEnv, ...vars };
        }
      } catch (err) {
        emitLog(`Warning: failed to decrypt env vars: ${err.message}`);
      }
    }

    // Add node_modules/.bin to PATH
    const binPath = path.join(workDir, 'node_modules', '.bin');
    buildEnv.PATH = `${binPath}:${buildEnv.PATH}`;

    try {
      // Use shell for build command (supports && etc.)
      await runCommand('sh', ['-c', buildCommand], {
        cwd: workDir,
        env: buildEnv,
      }, emitLog, signal);
    } catch (err) {
      throw new Error(`Build failed: ${sanitize(err.message)}`);
    }
    emitLog('✓ Build complete');
  } else {
    emitLog('No build command specified, skipping build step');
  }

  // Smart default: vanilla sites (no build) → '.' (repo root), build sites → 'dist'
  const outDir = outputDirectory || (buildCommand ? 'dist' : '.');
  const outputPath = path.resolve(workDir, outDir);

  // Containment check (I1)
  if (!outputPath.startsWith(buildDir)) {
    throw new Error(`Security: outputDirectory "${outDir}" escapes build directory`);
  }

  if (!fs.existsSync(outputPath)) {
    throw new Error(`Build output directory "${outDir}" not found. Check your build command and outputDirectory setting.`);
  }

  if (!fs.existsSync(path.join(outputPath, 'index.html'))) {
    emitLog(`Warning: no index.html found in ${outDir} — site may not load correctly`);
  }

  const fileCount = countFiles(outputPath);
  emitLog(`Output: ${fileCount} files in ${outDir}`);

  // Remove .git from output to avoid deploying git internals
  const gitDir = path.join(outputPath, '.git');
  if (fs.existsSync(gitDir)) {
    fs.rmSync(gitDir, { recursive: true, force: true });
    const cleanCount = countFiles(outputPath);
    emitLog(`Cleaned .git directory (${fileCount} → ${cleanCount} files)`);
  }

  return outputPath;
}

/**
 * Count files recursively in a directory.
 */
function countFiles(dir) {
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) count++;
      else if (entry.isDirectory()) count += countFiles(path.join(dir, entry.name));
    }
  } catch (_) {}
  return count;
}

module.exports = { run };
