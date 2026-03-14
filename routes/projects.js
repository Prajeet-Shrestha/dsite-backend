const { Router } = require('express');
const crypto = require('crypto');
const db = require('../db');
const { encrypt, decrypt } = require('../crypto');
const { requireAuth } = require('../middleware/auth');
const queue = require('../queue');
const { generateSlug, validateSlug } = require('../services/slugify');
const siteCache = require('../services/siteCache');
const usage = require('../services/usage');

const router = Router();

/**
 * POST /api/projects — Import a repository as a project
 * Wrapped in db.transaction() for atomic project limit check (S1, G15, G19)
 */
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { name, repoFullName, repoUrl, branch, rootDirectory, buildCommand, outputDirectory, envVars } = req.body;

    if (!repoFullName || !repoUrl) {
      return res.status(400).json({ error: 'repoFullName and repoUrl are required' });
    }

    const projectId = crypto.randomUUID();
    const projectName = name || repoFullName.split('/')[1] || repoFullName;

    // Encrypt env vars if provided
    let encryptedEnvVars = null;
    if (envVars && typeof envVars === 'object' && Object.keys(envVars).length > 0) {
      encryptedEnvVars = encrypt(JSON.stringify(envVars));
    }

    // Generate and validate slug for custom domain
    const slug = generateSlug(projectName);
    const slugErr = validateSlug(slug);
    if (slugErr) {
      return res.status(400).json({ error: slugErr });
    }

    // Atomic: check limit + insert (S1, G15)
    const limits = usage.getLimits(req.user.plan);
    const createInTransaction = db.transaction(() => {
      const count = usage.getProjectCount(req.user.id);
      if (count >= limits.projects) {
        const err = new Error('project_limit');
        err.limitData = { current: count, max: limits.projects, type: 'projects' };
        throw err;
      }

      db.prepare(`
        INSERT INTO projects (id, user_id, name, slug, repo_full_name, repo_url, branch, root_directory, build_command, output_directory, env_vars)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        projectId,
        req.user.id,
        projectName,
        slug,
        repoFullName,
        repoUrl,
        branch || 'main',
        rootDirectory || '',
        buildCommand || '',
        outputDirectory || '',
        encryptedEnvVars,
      );
    });

    try {
      createInTransaction();
    } catch (err) {
      // Project limit exceeded
      if (err.message === 'project_limit') {
        return res.status(403).json({
          error: `Project limit reached (${err.limitData.current}/${err.limitData.max}). Upgrade your plan.`,
          limit: err.limitData,
        });
      }
      // UNIQUE constraint violation → 409 (G19: preserved inside transaction)
      if (err.message?.includes('UNIQUE constraint failed')) {
        if (err.message.includes('slug')) {
          return res.status(409).json({ error: `"${slug}" is already taken as a site name` });
        }
        return res.status(409).json({ error: 'This repository is already imported' });
      }
      throw err;
    }

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);

    res.status(201).json({ project: sanitizeProject(project), warning: null });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/projects — List user's projects with latest deployment status
 */
router.get('/', requireAuth, (req, res) => {
  const projects = db.prepare(`
    SELECT p.*,
      d.status AS latest_deployment_status,
      d.walrus_url AS latest_deployment_url,
      d.created_at AS latest_deployment_at
    FROM projects p
    LEFT JOIN (
      SELECT project_id, status, walrus_url, created_at,
        ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rn
      FROM deployments
    ) d ON d.project_id = p.id AND d.rn = 1
    WHERE p.user_id = ?
    ORDER BY p.updated_at DESC
  `).all(req.user.id);

  res.json({ projects: projects.map(sanitizeProject) });
});

/**
 * GET /api/projects/:id — Project detail with recent deployments
 */
router.get('/:id', requireAuth, (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);

  if (!project) return res.status(404).json({ error: 'Project not found' });

  const deployments = db.prepare(`
    SELECT id, commit_sha, commit_message, status, trigger_type, error_message,
      walrus_url, COALESCE(sui_cost, 0) as sui_cost, COALESCE(wal_cost, 0) as wal_cost,
      started_at, completed_at, created_at
    FROM deployments WHERE project_id = ?
    ORDER BY created_at DESC
    LIMIT 20
  `).all(project.id);

  const costs = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(sui_cost, 0)), 0) as total_sui_cost,
           COALESCE(SUM(COALESCE(wal_cost, 0)), 0) as total_wal_cost
    FROM deployments WHERE project_id = ?
  `).get(project.id);

  res.json({ project: { ...sanitizeProject(project), ...costs }, deployments });
});

/**
 * PUT /api/projects/:id — Update project configuration
 */
router.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);

    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { name, branch, rootDirectory, buildCommand, outputDirectory, envVars } = req.body;

    // Env var merge: null = keep existing, {} = clear, {key:val} = set (J5)
    let encryptedEnvVars = project.env_vars;
    if (envVars !== undefined && envVars !== null) {
      if (Object.keys(envVars).length === 0) {
        encryptedEnvVars = null;
      } else {
        encryptedEnvVars = encrypt(JSON.stringify(envVars));
      }
    }

    db.prepare(`
      UPDATE projects SET
        name = COALESCE(?, name),
        branch = COALESCE(?, branch),
        root_directory = COALESCE(?, root_directory),
        build_command = COALESCE(?, build_command),
        output_directory = COALESCE(?, output_directory),
        env_vars = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      name || null,
      branch || null,
      rootDirectory !== undefined ? rootDirectory : null,
      buildCommand !== undefined ? buildCommand : null,
      outputDirectory !== undefined ? outputDirectory : null,
      encryptedEnvVars,
      project.id,
    );

    const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
    res.json({ project: sanitizeProject(updated) });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/projects/:id — Delete project and all deployments
 */
router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const project = db.prepare('SELECT * FROM projects WHERE id = ? AND user_id = ?')
      .get(req.params.id, req.user.id);

    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Cancel any active builds
    queue.cancelBuild(project.id);

    // Note: webhook deletion deferred to Sprint 2 (Y5)
    // if (project.webhook_id) { await github.deleteWebhook(...) }

    // Invalidate site cache for custom domain
    if (project.slug) siteCache.invalidate(project.slug);

    // Delete project (deployments cascade via FK)
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Sanitize project for API response.
 * Env vars: return keys only, not values (I7).
 */
function sanitizeProject(project) {
  const sanitized = { ...project };

  if (sanitized.env_vars) {
    try {
      const decrypted = decrypt(sanitized.env_vars);
      if (decrypted) {
        const vars = JSON.parse(decrypted);
        sanitized.env_var_keys = Object.keys(vars);
      } else {
        sanitized.env_var_keys = [];
      }
    } catch (_) {
      sanitized.env_var_keys = [];
    }
  } else {
    sanitized.env_var_keys = [];
  }
  delete sanitized.env_vars;
  delete sanitized.access_token;

  return sanitized;
}

module.exports = router;
