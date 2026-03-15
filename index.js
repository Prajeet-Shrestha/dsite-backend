// ── dSite Backend ──
require('dotenv').config();

const express = require('express');
const session = require('express-session');
const cors = require('cors');
const db = require('./db');

// Session store — Gap #2: factory pattern, Gap #25: client = db instance
const SqliteStore = require('better-sqlite3-session-store')(session);

const authRoutes = require('./routes/auth');
const reposRoutes = require('./routes/repos');
const projectsRoutes = require('./routes/projects');
const deploymentsRoutes = require('./routes/deployments');
const usageRoutes = require('./routes/usage');
const queue = require('./queue');
const deployer = require('./services/deployer');

const app = express();
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// Production: trust first proxy (L1)
if (isProd) app.set('trust proxy', 1);

// ── Startup Validation (Z5) ──
if (!process.env.ADMIN_MNEMONICS) {
  console.error('❌ ADMIN_MNEMONICS not set. Cannot deploy to Walrus.');
  process.exit(1);
}

// ── Site Proxy: *.SITE_DOMAIN → Walrus Portal ──
// MUST be before CORS, session, and body parsing so user site requests
// are proxied raw without Express middleware interference.
const SITE_DOMAIN = process.env.SITE_DOMAIN;
const PORTAL_URL = process.env.PORTAL_URL;

if (SITE_DOMAIN && PORTAL_URL) {
  const { createProxyMiddleware } = require('http-proxy-middleware');
  const siteCache = require('./services/siteCache');
  const { RESERVED } = require('./services/slugify');

  const usage = require('./services/usage');

  const siteProxy = createProxyMiddleware({
    target: PORTAL_URL,
    changeOrigin: true,
    on: {
      proxyReq: (proxyReq, req) => {
        if (req._portalHost) proxyReq.setHeader('Host', req._portalHost);
      },
      proxyRes: (proxyRes, req) => {
        // G11: count wire bytes for bandwidth tracking
        if (req._siteUserId) {
          let bytes = 0;
          proxyRes.on('data', (chunk) => { bytes += chunk.length; });
          proxyRes.on('end', () => {
            if (bytes > 0) usage.accumulateBandwidth(req._siteUserId, bytes);
          });
        }
      },
      error: (_err, _req, res) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/html' });
          res.end('<h1>Site temporarily unavailable</h1><p>Please try again later.</p>');
        }
      },
    },
  });

  app.use((req, res, next) => {
    const host = req.hostname;

    // Guard: skip if hostname is missing (malformed requests from bots/scanners)
    if (!host) return next();

    // Only handle *.SITE_DOMAIN subdomains, not root domain or other hosts
    if (host === SITE_DOMAIN || !host.endsWith(`.${SITE_DOMAIN}`)) return next();
    // Let API paths through to Express routes
    if (req.path.startsWith('/api')) return next();

    const subdomain = host.slice(0, -(SITE_DOMAIN.length + 1));

    // Reject multi-level subdomains and invalid chars
    if (subdomain.includes('.') || !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) {
      return res.status(400).send('Invalid subdomain');
    }

    // Block reserved subdomains
    if (RESERVED.has(subdomain)) {
      return res.status(404).send('Reserved subdomain');
    }

    // Check cache
    const cached = siteCache.get(subdomain);
    if (cached === 'NONE') return res.status(404).send('Site not found');
    if (cached) {
      req._portalHost = `${cached.b36}.localhost`;
      req._siteUserId = cached.userId;
      return siteProxy(req, res, next);
    }

    // DB lookup (G2: include user_id for bandwidth attribution)
    const project = db.prepare('SELECT walrus_object_id, user_id FROM projects WHERE slug = ?').get(subdomain);
    if (!project || !project.walrus_object_id) {
      siteCache.set(subdomain, 'NONE');
      return res.status(404).send(project ? 'Site not deployed yet' : 'Site not found');
    }

    const b36 = BigInt(project.walrus_object_id).toString(36);
    siteCache.set(subdomain, { b36, userId: project.user_id });
    req._portalHost = `${b36}.localhost`;
    req._siteUserId = project.user_id;
    siteProxy(req, res, next);
  });

  console.log(`✓ Site proxy enabled: *.${SITE_DOMAIN} → ${PORTAL_URL}`);
}

// ── CORS (Gap #16, #17) ──
const allowedOrigin = process.env.CLIENT_URL || 'http://localhost:5173';
console.log(`✓ CORS origin: ${allowedOrigin}`);
app.use(cors({
  origin: allowedOrigin,
  credentials: true,
}));

// ── Body parsing ──
app.use(express.json());

// ── Request Logger ──
app.use((req, res, next) => {
  const start = Date.now();
  const { method, path: urlPath } = req;
  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const level = status >= 500 ? '❌' : status >= 400 ? '⚠' : '✓';
    console.log(`${level} ${method} ${urlPath} → ${status} (${ms}ms)`);
  });
  next();
});

// ── Session (Gap #21: resave + saveUninitialized, Gap #25: client) ──
app.use(session({
  store: new SqliteStore({
    client: db,
    expired: {
      clear: true,
      intervalMs: 15 * 60 * 1000, // Clean expired sessions every 15 min
    },
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    sameSite: 'lax',
    httpOnly: true,
    secure: isProd, // HTTPS required when sameSite='none'
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  },
}));

// ── Routes ──
app.use('/api/auth', authRoutes);
app.use('/api', reposRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api', deploymentsRoutes);
app.use('/api', usageRoutes);

// ── Health check ──
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// ── Global error handler (Gap #20) ──
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
  });
});

// ── Startup ──
async function start() {
  // Mark interrupted builds from previous crash/restart (H1)
  queue.markInterruptedBuilds();

  // Migrate: auto-generate slugs for existing projects
  const { generateSlug } = require('./services/slugify');
  const unslugged = db.prepare('SELECT id, name FROM projects WHERE slug IS NULL').all();
  for (const p of unslugged) {
    let slug = generateSlug(p.name) || p.id.slice(0, 8);
    let final = slug, i = 2;
    while (db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(final)) {
      final = `${slug}-${i++}`;
    }
    db.prepare('UPDATE projects SET slug = ? WHERE id = ?').run(final, p.id);
    console.log(`  Migrated slug: ${p.name} → ${final}`);
  }

  // Set up the deployer wallet from ADMIN_MNEMONICS (Z1)
  try {
    await deployer.setupWallet();
  } catch (err) {
    console.error('⚠ Wallet setup failed:', err.message);
    console.error('Deployments will fail until wallet is configured.');
  }

  app.listen(PORT, () => {
    console.log(`✓ dSite backend running on http://localhost:${PORT}`);
    console.log(`  NODE_ENV    = ${process.env.NODE_ENV || 'development'}`);
    console.log(`  CLIENT_URL  = ${process.env.CLIENT_URL || '(not set)'}`);
    console.log(`  SITE_DOMAIN = ${process.env.SITE_DOMAIN || '(not set)'}`);
  });
}

// ── Graceful Shutdown (W2) ──
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down...');
  try { require('./services/usage').flushBandwidth(); } catch (_) {}
  setTimeout(() => process.exit(0), 2000);
});

process.on('SIGINT', () => {
  console.log('SIGINT received — shutting down...');
  try { require('./services/usage').flushBandwidth(); } catch (_) {}
  setTimeout(() => process.exit(0), 2000);
});

start();
