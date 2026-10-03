-- FaceID Platform (Cloudflare D1). The API creates these tables automatically on first
-- request; this file is only a reference / for `wrangler d1 execute faceid --file schema.sql`.
CREATE TABLE IF NOT EXISTS organizations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, sector TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Africa/Algiers', work_start TEXT NOT NULL DEFAULT '08:30', late_tolerance INTEGER NOT NULL DEFAULT 10, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', subscription_end TEXT NOT NULL, descriptor TEXT, consent_at TEXT);
CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, org_id INTEGER NOT NULL, member_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, created_at TEXT NOT NULL, method TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'granted', local_date TEXT NOT NULL, local_time TEXT NOT NULL, late INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS members_org ON members(org_id);
CREATE INDEX IF NOT EXISTS entries_org_day ON entries(org_id, local_date);
CREATE INDEX IF NOT EXISTS entries_member ON entries(org_id, member_id, created_at);
