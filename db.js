// ── SQLite Database ──
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// Data directory — configurable via DATA_DIR env, defaults to ./data
const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Builds directory — ephemeral clone/build workspaces
const buildsDir = path.join(dataDir, 'builds');
fs.mkdirSync(buildsDir, { recursive: true });

const db = new Database(path.join(dataDir, 'dsite.db'));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
// Enforce foreign key constraints
db.pragma('foreign_keys = ON');
// Wait up to 5s for write lock instead of failing immediately
db.pragma('busy_timeout = 5000');

// ── Create Tables ──
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    github_id INTEGER UNIQUE NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT,
    access_token TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    name TEXT NOT NULL,
    repo_full_name TEXT NOT NULL,
    repo_url TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'main',
    root_directory TEXT DEFAULT '',
    build_command TEXT DEFAULT '',
    output_directory TEXT DEFAULT '',
    env_vars TEXT DEFAULT NULL,
    walrus_object_id TEXT DEFAULT NULL,
    walrus_url TEXT DEFAULT NULL,
    webhook_id TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, repo_full_name)
  );

  CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    commit_sha TEXT,
    commit_message TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    trigger_type TEXT NOT NULL DEFAULT 'manual',
    error_message TEXT DEFAULT NULL,
    walrus_url TEXT DEFAULT NULL,
    logs TEXT DEFAULT NULL,
    started_at TEXT DEFAULT NULL,
    completed_at TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Migration: add cost tracking columns (idempotent)
try { db.exec('ALTER TABLE deployments ADD COLUMN sui_cost REAL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE deployments ADD COLUMN wal_cost REAL DEFAULT 0'); } catch {}

// Migration: add slug column for custom domain routing (idempotent)
// SQLite doesn't allow UNIQUE in ALTER TABLE — use CREATE UNIQUE INDEX instead
try { db.exec('ALTER TABLE projects ADD COLUMN slug TEXT DEFAULT NULL'); } catch {}
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug)'); } catch {}

module.exports = db;
module.exports.dataDir = dataDir;
module.exports.buildsDir = buildsDir;
