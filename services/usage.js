// ── Usage Tracking Service ──
// Records events, enforces limits, and manages bandwidth accumulation.
const db = require('../db');
const fs = require('fs');
const path = require('path');

// ── Allowed event types (G20) ──
const ALLOWED_TYPES = new Set(['deployment', 'build_minutes', 'bandwidth']);

// ── Prepared statements (cached) ──
const stmts = {
  insertEvent: db.prepare(`
    INSERT INTO usage_events (user_id, project_id, deployment_id, event_type, value, unit, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `),
  sumByType: db.prepare(`
    SELECT COALESCE(SUM(value), 0) as total
    FROM usage_events
    WHERE user_id = ? AND event_type = ? AND created_at >= ?
  `),
  projectCount: db.prepare('SELECT COUNT(*) as c FROM projects WHERE user_id = ?'),
  usageSummary: db.prepare(`
    SELECT event_type, COALESCE(SUM(value), 0) as total
    FROM usage_events
    WHERE user_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY event_type
  `),
  costSummary: db.prepare(`
    SELECT
      COALESCE(SUM(json_extract(metadata, '$.sui_cost')), 0) as sui_cost,
      COALESCE(SUM(json_extract(metadata, '$.wal_cost')), 0) as wal_cost
    FROM usage_events
    WHERE user_id = ? AND event_type = 'deployment' AND created_at >= ? AND created_at < ?
  `),
  usageHistory: db.prepare(`
    SELECT
      strftime('%Y-%m', created_at) as month,
      event_type,
      COALESCE(SUM(value), 0) as total
    FROM usage_events
    WHERE user_id = ? AND created_at >= ?
    GROUP BY month, event_type
    ORDER BY month DESC
  `),
  costHistory: db.prepare(`
    SELECT
      strftime('%Y-%m', created_at) as month,
      COALESCE(SUM(json_extract(metadata, '$.sui_cost')), 0) as sui_cost,
      COALESCE(SUM(json_extract(metadata, '$.wal_cost')), 0) as wal_cost
    FROM usage_events
    WHERE user_id = ? AND event_type = 'deployment' AND created_at >= ?
    GROUP BY month
    ORDER BY month DESC
  `),
};

// ── Limits (G23: configurable via env) ──
function getLimits(plan) {
  // Only 'free' tier for now — future tiers add entries here
  return {
    deployments: parseInt(process.env.LIMIT_DEPLOYS_PER_MONTH) || 100,
    build_minutes: parseInt(process.env.LIMIT_BUILD_MINUTES) || 6000,
    projects: parseInt(process.env.LIMIT_PROJECTS) || 20,
    bandwidth: (parseInt(process.env.LIMIT_BANDWIDTH_GB) || 100) * 1024 * 1024 * 1024,
  };
}

// ── Period helpers ──
function getCurrentPeriod() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59));
  return {
    start: start.toISOString().replace('T', ' ').slice(0, 19),
    end: end.toISOString().replace('T', ' ').slice(0, 19),
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}

// ── Record an event (G20: validates type, S4: validates value) ──
function recordEvent(userId, type, value, unit, opts = {}) {
  if (!ALLOWED_TYPES.has(type)) {
    throw new Error(`Invalid event type: "${type}". Allowed: ${[...ALLOWED_TYPES].join(', ')}`);
  }
  if (typeof value !== 'number' || value < 0) {
    throw new Error(`Invalid event value: ${value}. Must be >= 0`);
  }
  const metadata = opts.metadata ? JSON.stringify(opts.metadata) : null;
  stmts.insertEvent.run(
    userId,
    opts.projectId || null,
    opts.deploymentId || null,
    type,
    value,
    unit,
    metadata,
    opts.createdAt || null,
  );
}

// ── Check a limit (read-only) ──
function checkLimit(userId, eventType) {
  const period = getCurrentPeriod();
  const limits = getLimits('free');

  let current;
  if (eventType === 'projects') {
    current = stmts.projectCount.get(userId).c;
  } else {
    current = stmts.sumByType.get(userId, eventType, period.start).total;
  }

  const limit = limits[eventType];
  const allowed = limit === undefined || limit === null || current < limit;

  return { allowed, current, limit, remaining: Math.max(0, (limit || 0) - current) };
}

// ── Get project count (G15: live count) ──
function getProjectCount(userId) {
  return stmts.projectCount.get(userId).c;
}

// ── Usage summary for a period ──
function getUsageSummary(userId) {
  const period = getCurrentPeriod();
  const limits = getLimits('free');

  // Aggregate by event type
  const rows = stmts.usageSummary.all(userId, period.start, period.end);
  const byType = {};
  for (const row of rows) {
    byType[row.event_type] = row.total;
  }

  // Costs from deployment metadata
  const costs = stmts.costSummary.get(userId, period.start, period.end);

  // Project count is live, not from events
  const projectCount = getProjectCount(userId);

  return {
    plan: 'free',
    period: { start: period.startISO, end: period.endISO },
    usage: {
      deployments: { current: byType.deployment || 0, limit: limits.deployments, unit: 'count' },
      build_minutes: { current: Math.round((byType.build_minutes || 0) * 100) / 100, limit: limits.build_minutes, unit: 'minutes' },
      projects: { current: projectCount, limit: limits.projects, unit: 'count' },
      bandwidth: { current: byType.bandwidth || 0, limit: limits.bandwidth, unit: 'bytes' },
      sui_cost: { current: Math.round((costs.sui_cost || 0) * 10000) / 10000, limit: null, unit: 'SUI' },
      wal_cost: { current: Math.round((costs.wal_cost || 0) * 100) / 100, limit: null, unit: 'WAL' },
    },
  };
}

// ── Usage history (month-by-month) ──
function getUsageHistory(userId, months = 6) {
  // Clamp months (E6)
  months = Math.max(1, Math.min(12, parseInt(months) || 6));

  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - months);
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const sinceStr = since.toISOString().replace('T', ' ').slice(0, 19);

  const rows = stmts.usageHistory.all(userId, sinceStr);
  const costRows = stmts.costHistory.all(userId, sinceStr);

  // Pivot: group by month
  const monthMap = new Map();
  for (const row of rows) {
    if (!monthMap.has(row.month)) {
      monthMap.set(row.month, { month: row.month, deployments: 0, build_minutes: 0, bandwidth: 0, sui_cost: 0, wal_cost: 0 });
    }
    const entry = monthMap.get(row.month);
    if (row.event_type === 'deployment') entry.deployments = row.total;
    else if (row.event_type === 'build_minutes') entry.build_minutes = Math.round(row.total * 100) / 100;
    else if (row.event_type === 'bandwidth') entry.bandwidth = row.total;
  }
  for (const row of costRows) {
    const entry = monthMap.get(row.month);
    if (entry) {
      entry.sui_cost = Math.round((row.sui_cost || 0) * 10000) / 10000;
      entry.wal_cost = Math.round((row.wal_cost || 0) * 100) / 100;
    }
  }

  return { history: [...monthMap.values()] };
}

// ── Bandwidth Accumulator (G3, G13, G17, E10) ──
const bandwidthMap = new Map(); // userId → accumulated bytes
const BW_MAX_ENTRIES = 10000;
let isFlushing = false;

function accumulateBandwidth(userId, bytes) {
  if (!userId || bytes <= 0) return;
  bandwidthMap.set(userId, (bandwidthMap.get(userId) || 0) + bytes);

  // Flush-all on overflow (G3)
  if (bandwidthMap.size >= BW_MAX_ENTRIES) {
    flushBandwidth();
  }
}

function flushBandwidth() {
  if (isFlushing || bandwidthMap.size === 0) return;
  isFlushing = true;

  const entries = [...bandwidthMap.entries()];
  try {
    const batchInsert = db.transaction(() => {
      for (const [userId, bytes] of entries) {
        stmts.insertEvent.run(userId, null, null, 'bandwidth', bytes, 'bytes', null, null);
      }
    });
    batchInsert();
    // Clear only after successful write
    for (const [userId] of entries) {
      bandwidthMap.delete(userId);
    }
  } catch (err) {
    // G13: retain entries for next flush
    console.error('Bandwidth flush failed (will retry):', err.message);
  } finally {
    isFlushing = false;
  }
}

// Start 60s flush interval
const flushInterval = setInterval(flushBandwidth, 60000);
flushInterval.unref(); // Don't keep process alive for this

// ── dirSize (G6, S5) ──
function dirSize(dir, maxDepth = 10) {
  if (maxDepth <= 0) return 0;
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        const stat = fs.lstatSync(fullPath); // S5: lstatSync, skip symlinks
        if (stat.isSymbolicLink()) continue;
        if (stat.isFile()) total += stat.size;
        else if (stat.isDirectory()) total += dirSize(fullPath, maxDepth - 1);
      } catch (_) {}
    }
  } catch (_) {}
  return total;
}

module.exports = {
  recordEvent,
  checkLimit,
  getLimits,
  getProjectCount,
  getUsageSummary,
  getUsageHistory,
  getCurrentPeriod,
  accumulateBandwidth,
  flushBandwidth,
  dirSize,
};
