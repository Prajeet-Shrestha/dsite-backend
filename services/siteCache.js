// ── Bounded LRU Cache for slug → base36 mapping ──
// Prevents memory exhaustion from subdomain scanning attacks

const cache = new Map();
const TTL = 60_000;
const MAX_SIZE = 10_000;

function evictOldest() {
  if (cache.size >= MAX_SIZE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

module.exports = {
  get(slug) {
    const e = cache.get(slug);
    if (!e || Date.now() - e.ts > TTL) { cache.delete(slug); return null; }
    // Move to end (LRU refresh)
    cache.delete(slug);
    cache.set(slug, e);
    return e.val;
  },
  set(slug, val) {
    cache.delete(slug);
    evictOldest();
    cache.set(slug, { val, ts: Date.now() });
  },
  invalidate(slug) { cache.delete(slug); },
};
