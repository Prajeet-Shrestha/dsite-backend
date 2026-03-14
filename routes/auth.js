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
  console.log('[Auth] OAuth initiation - generating state...');
  const state = crypto.randomBytes(32).toString('hex');
  req.session.oauthState = state;
  req.session.save((err) => {
    if (err) {
      console.error('[Auth] Session save error:', err);
      return res.status(500).json({ error: 'Session error' });
    }
    const params = new URLSearchParams({
      client_id: process.env.GITHUB_CLIENT_ID,
      scope: 'repo admin:repo_hook read:user',
      state,
    });
    const url = `https://github.com/login/oauth/authorize?${params}`;
    console.log(`[Auth] Redirecting to GitHub OAuth (client_id=${process.env.GITHUB_CLIENT_ID})`);
    res.redirect(url);
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
    console.log(`[Auth] Callback received - query: error=${req.query.error || 'none'}, code=${req.query.code ? 'present' : 'missing'}, state=${req.query.state ? 'present' : 'missing'}`);

    // Handle denial
    if (req.query.error) {
      console.log(`[Auth] OAuth denied: ${req.query.error}`);
      return res.redirect(`${process.env.CLIENT_URL}/login?error=denied`);
    }

    // Verify CSRF state
    if (!req.query.state || req.query.state !== req.session.oauthState) {
      console.error(`[Auth] State mismatch! query=${req.query.state}, session=${req.session.oauthState}`);
      return res.status(403).json({ error: 'State mismatch — possible CSRF' });
    }
    delete req.session.oauthState;

    // Exchange code for token
    console.log('[Auth] Exchanging code for token...');
    const token = await github.exchangeCodeForToken(req.query.code);
    console.log('[Auth] Token obtained, fetching user...');
    const ghUser = await github.getUser(token);
    console.log(`[Auth] GitHub user: ${ghUser.login} (id=${ghUser.id})`);
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
    console.log(`[Auth] User logged in: ${ghUser.login} (userId=${user.id})`);

    req.session.save((err) => {
      if (err) {
        console.error('[Auth] Session save error after login:', err);
        return next(err);
      }
      const redirectUrl = `${process.env.CLIENT_URL}/dashboard`;
      console.log(`[Auth] Redirecting to: ${redirectUrl}`);
      res.redirect(redirectUrl);
    });
  } catch (err) {
    console.error('[Auth] Callback error:', err);
    next(err);
  }
});

/**
 * GET /api/auth/me — Current user
 * Gap #7: Response must match frontend User type exactly.
 */
router.get('/me', requireAuth, (req, res) => {
  console.log(`[Auth] /me - user=${req.user.username}`);
  res.json({
    id: req.user.id,
    username: req.user.username,
    avatar_url: req.user.avatarUrl,
    github_id: req.user.githubId,
    plan: req.user.plan,
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
