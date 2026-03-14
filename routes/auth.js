// ── Auth Routes ──
const { Router } = require('express');
const crypto = require('crypto');
const db = require('../db');
const { encrypt } = require('../crypto');
const { requireAuth } = require('../middleware/auth');
const github = require('../services/github');

const router = Router();

/**
 * GET /api/auth/github — Initiate OAuth
 * Gap #3: session.save() before redirect
 * Gap #6: Omit redirect_uri — rely on app settings
 */
router.get('/github', (req, res) => {
  const state = crypto.randomBytes(32).toString('hex');
  req.session.oauthState = state;
  req.session.save((err) => {
    if (err) {
      console.error('Session save error:', err);
      return res.status(500).json({ error: 'Session error' });
    }
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID,
      scope: 'repo admin:repo_hook read:user',
      state,
    });
    res.redirect(`https://github.com/login/oauth/authorize?${params}`);
  });
});

/**
 * GET /api/auth/github/callback — Handle OAuth callback
 * Gap #20: try/catch for Express 4 async safety
 * Gap #22: ON CONFLICT upsert for re-login
 * Gap #23: GitHub sends ?error=access_denied — normalize to 'denied'
 * Gap #24: crypto.randomUUID() instead of uuid package
 */
router.get('/github/callback', async (req, res, next) => {
  try {
    // Handle denial
    if (req.query.error) {
      return res.redirect(`${process.env.CLIENT_URL}/login?error=denied`);
    }

    // Verify CSRF state
    if (!req.query.state || req.query.state !== req.session.oauthState) {
      return res.status(403).json({ error: 'State mismatch — possible CSRF' });
    }
    delete req.session.oauthState;

    // Exchange code for token
    const token = await github.exchangeCodeForToken(req.query.code);
    const ghUser = await github.getUser(token);
    const encryptedToken = encrypt(token);
    const userId = crypto.randomUUID();

    // Upsert user — update token/avatar on re-login
    db.prepare(`
      INSERT INTO users (id, github_id, username, avatar_url, access_token)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(github_id) DO UPDATE SET
        username = excluded.username,
        avatar_url = excluded.avatar_url,
        access_token = excluded.access_token
    `).run(userId, ghUser.id, ghUser.login, ghUser.avatar_url, encryptedToken);

    // Get actual user id (upsert may have kept the original row's id)
    const user = db.prepare('SELECT id FROM users WHERE github_id = ?').get(ghUser.id);
    req.session.userId = user.id;

    req.session.save((err) => {
      if (err) return next(err);
      res.redirect(`${process.env.CLIENT_URL}/dashboard`);
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me — Current user
 * Gap #7: Response must match frontend User type exactly.
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    avatar_url: req.user.avatarUrl,
    github_id: req.user.githubId,
  });
});

/**
 * POST /api/auth/logout — Destroy session
 */
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Session destroy error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

module.exports = router;
