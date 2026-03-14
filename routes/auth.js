// ── Auth Routes ──
const { Router } = require('express');
const crypto = require('crypto');
const db = require('../db');
const { encrypt } = require('../crypto');
const { requireAuth } = require('../middleware/auth');
const github = require('../services/github');

const router = Router();

// ── One-time auth codes (in-memory, expires in 60s) ──
const pendingCodes = new Map(); // code → { userId, expiresAt }

function cleanExpiredCodes() {
  const now = Date.now();
  for (const [code, data] of pendingCodes) {
    if (data.expiresAt < now) pendingCodes.delete(code);
  }
}

/**
 * GET /api/auth/github — Initiate OAuth
 * Uses HMAC-signed timestamp as state (stateless — no session needed).
 */
router.get('/github', (_req, res) => {
  console.log('[Auth] OAuth initiation...');
  // Stateless CSRF: HMAC(timestamp) — verifiable without session
  const ts = Date.now().toString();
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(ts).digest('hex');
  const state = `${ts}.${sig}`;

  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    scope: 'repo admin:repo_hook read:user',
    state,
    login: '',  // Force GitHub to show account picker instead of auto-login
  });
  const url = `https://github.com/login/oauth/authorize?${params}`;
  console.log(`[Auth] Redirecting to GitHub OAuth (client_id=${process.env.GITHUB_CLIENT_ID})`);
  res.redirect(url);
});

/**
 * GET /api/auth/github/callback — Handle OAuth callback
 * Verifies stateless HMAC state, exchanges code, generates one-time auth code.
 */
router.get('/github/callback', async (req, res, next) => {
  try {
    console.log(`[Auth] Callback received - error=${req.query.error || 'none'}, code=${req.query.code ? 'present' : 'missing'}, state=${req.query.state ? 'present' : 'missing'}`);

    // Handle denial
    if (req.query.error) {
      console.log(`[Auth] OAuth denied: ${req.query.error}`);
      return res.redirect(`${process.env.CLIENT_URL}/login?error=denied`);
    }

    // Verify stateless HMAC state (valid for 10 minutes)
    const [ts, sig] = (req.query.state || '').split('.');
    const expectedSig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(ts || '').digest('hex');
    if (!ts || !sig || sig !== expectedSig) {
      console.error('[Auth] State signature mismatch');
      return res.status(403).json({ error: 'State mismatch — possible CSRF' });
    }
    if (Date.now() - parseInt(ts) > 10 * 60 * 1000) {
      console.error('[Auth] State expired');
      return res.status(403).json({ error: 'OAuth state expired — please try again' });
    }

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

    // Get actual user id
    const user = db.prepare('SELECT id FROM users WHERE github_id = ?').get(ghUser.id);
    console.log(`[Auth] User authenticated: ${ghUser.login} (userId=${user.id})`);

    // Generate one-time auth code (instead of setting session directly)
    cleanExpiredCodes();
    const authCode = crypto.randomBytes(32).toString('hex');
    pendingCodes.set(authCode, { userId: user.id, expiresAt: Date.now() + 60_000 });
    console.log(`[Auth] Generated auth code, redirecting to frontend callback...`);

    const redirectUrl = `${process.env.CLIENT_URL}/auth/callback?code=${authCode}`;
    console.log(`[Auth] Redirecting to: ${redirectUrl}`);
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('[Auth] Callback error:', err);
    next(err);
  }
});

/**
 * POST /api/auth/exchange — Exchange one-time code for session
 * Called by the frontend through the Vercel proxy (same domain = cookies work).
 */
router.post('/exchange', (req, res) => {
  const { code } = req.body;
  console.log(`[Auth] Exchange request - code=${code ? 'present' : 'missing'}`);

  if (!code) {
    return res.status(400).json({ error: 'Missing code' });
  }

  cleanExpiredCodes();
  const pending = pendingCodes.get(code);
  if (!pending) {
    console.error('[Auth] Exchange failed - invalid or expired code');
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  // Consume the code (one-time use)
  pendingCodes.delete(code);

  // Look up the user
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(pending.userId);
  if (!user) {
    console.error(`[Auth] Exchange failed - user not found: ${pending.userId}`);
    return res.status(401).json({ error: 'User not found' });
  }

  // Set session (cookie will be set by express-session on this same-domain request)
  req.session.userId = user.id;
  req.session.save((err) => {
    if (err) {
      console.error('[Auth] Session save error during exchange:', err);
      return res.status(500).json({ error: 'Session error' });
    }
    console.log(`[Auth] Exchange successful — session set for ${user.username} (${user.id})`);
    res.json({
      id: user.id,
      username: user.username,
      avatar_url: user.avatar_url,
      github_id: user.github_id,
      plan: user.plan || 'free',
    });
  });
});

/**
 * GET /api/auth/me — Current user
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
