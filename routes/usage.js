// ── Usage Routes ──
const { Router } = require('express');
const { requireAuth } = require('../middleware/auth');
const usage = require('../services/usage');

const router = Router();

/**
 * GET /api/usage — Current period usage summary + plan limits
 */
router.get('/usage', requireAuth, (_req, res) => {
  const summary = usage.getUsageSummary(_req.user.id);
  res.set('Cache-Control', 'private, max-age=30');
  res.json(summary);
});

/**
 * GET /api/usage/history?months=6 — Month-by-month usage history
 * months is clamped to [1, 12], defaults to 6
 */
router.get('/usage/history', requireAuth, (req, res) => {
  const months = req.query.months;
  const history = usage.getUsageHistory(req.user.id, months);
  res.set('Cache-Control', 'private, max-age=30');
  res.json(history);
});

module.exports = router;
