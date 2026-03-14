// ── Repo Routes ──
const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const github = require('../services/github');

const router = Router();
const PAGE_SIZE = 5;

/**
 * GET /api/repos — List user's repos (server-side search + paginate)
 * Gap #8: Fetch all repos with proper sort/affiliation params
 * Gap #9: Server-side filter then paginate for accurate search
 * Gap #10: Map to frontend Repo shape
 * Gap #11: hasMore based on filtered count
 */
router.get('/repos', requireAuth, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const q = req.query.q?.toLowerCase();

    const allRepos = await github.getUserRepos(req.user.token);

    // Map to frontend Repo shape
    let mapped = allRepos.map((r) => ({
      id: r.id,
      full_name: r.full_name,
      name: r.name,
      private: r.private,
      language: r.language || null,
      updated_at: r.updated_at,
    }));

    // Server-side search filter
    if (q) {
      mapped = mapped.filter(
        (r) =>
          r.full_name.toLowerCase().includes(q) ||
          r.name.toLowerCase().includes(q)
      );
    }

    const start = (page - 1) * PAGE_SIZE;
    const repos = mapped.slice(start, start + PAGE_SIZE);
    const hasMore = start + PAGE_SIZE < mapped.length;

    res.json({ repos, hasMore });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/repos/:owner/:repo/branches
 * Gap #12: Direct passthrough, map to { name } only
 */
router.get('/repos/:owner/:repo/branches', requireAuth, async (req, res, next) => {
  try {
    const branches = await github.getRepoBranches(
      req.user.token,
      req.params.owner,
      req.params.repo
    );
    res.json(branches.map((b) => ({ name: b.name })));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/repos/:owner/:repo/detect — Framework detection
 * Gap #13: base64 decode handled in github.getRepoFile
 * Gap #14: 404 fallback → Static HTML
 * Gap #15: ?root= monorepo support
 */
router.get('/repos/:owner/:repo/detect', requireAuth, async (req, res, next) => {
  try {
    const root = req.query.root || '';
    const filePath = root ? `${root}/package.json` : 'package.json';

    const pkg = await github.getRepoFile(
      req.user.token,
      req.params.owner,
      req.params.repo,
      filePath
    );

    // No package.json → Static HTML
    if (!pkg) {
      return res.json({
        framework: 'Static HTML',
        buildCommand: '',
        installCommand: '',
        outputDirectory: '.',
      });
    }

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    let framework = 'Unknown';
    let buildCommand = 'npm run build';
    let outputDirectory = 'dist';
    let installCommand = 'npm install';

    if (deps['vite'] || deps['@vitejs/plugin-react']) {
      framework = 'Vite';
      outputDirectory = 'dist';
    } else if (deps['next']) {
      framework = 'Next.js';
      outputDirectory = 'out';
      buildCommand = 'next build && next export';
    } else if (deps['react-scripts']) {
      framework = 'Create React App';
      outputDirectory = 'build';
    } else if (deps['@angular/core']) {
      framework = 'Angular';
      outputDirectory = 'dist';
    } else if (deps['vue']) {
      framework = 'Vue';
      outputDirectory = 'dist';
    } else if (deps['astro']) {
      framework = 'Astro';
      outputDirectory = 'dist';
    } else if (deps['svelte'] || deps['@sveltejs/kit']) {
      framework = 'SvelteKit';
      outputDirectory = 'build';
    } else if (deps['gatsby']) {
      framework = 'Gatsby';
      outputDirectory = 'public';
    }

    res.json({ framework, buildCommand, installCommand, outputDirectory });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
