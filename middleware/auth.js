// ── Auth Middleware ──
const db = require('../db');
const { decrypt } = require('../crypto');

/**
 * Require authenticated session.
 * Looks up user by session.userId, decrypts their GitHub token.
 * Attaches req.user = { id, githubId, username, avatarUrl, token }.
 */
function requireAuth(req, res, next) {
  const userId = req.session?.userId;
  if (!userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!row) {
    // User in session but not in DB — stale session
    req.session.destroy(() => {});
    return res.status(401).json({ error: 'User not found' });
  }

  try {
    req.user = {
      id: row.id,
      githubId: row.github_id,
      username: row.username,
      avatarUrl: row.avatar_url,
      plan: row.plan || 'free',
      token: decrypt(row.access_token),
    };
    next();
  } catch (err) {
    console.error('Token decryption failed:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { requireAuth };
