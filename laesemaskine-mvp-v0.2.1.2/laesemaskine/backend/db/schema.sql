-- Læsemaskine database schema (SQLite)
-- Version: 0.2.1.2.2
-- Generated: 2026-02-16

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS lm_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lm_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('elev','admin')),
  group_id INTEGER NULL,
  display_name TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(group_id) REFERENCES lm_groups(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS lm_mastery (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  level INTEGER NOT NULL,
  mastery_1_10 INTEGER NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, level),
  FOREIGN KEY(user_id) REFERENCES lm_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lm_ai_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dispute_id INTEGER NOT NULL,
  audio_path TEXT NOT NULL,
  expected TEXT NOT NULL,
  recognized TEXT NULL,
  error_type TEXT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','exported','deleted')) DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  exported_at TEXT NULL,
  FOREIGN KEY(dispute_id) REFERENCES lm_disputes(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS lm_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at TEXT NULL,
  estimated_level INTEGER NULL,
  correct_total INTEGER NOT NULL DEFAULT 0,
  total_words INTEGER NOT NULL DEFAULT 0,
  feedback_mode TEXT NOT NULL CHECK(feedback_mode IN ('per_word','after_test')) DEFAULT 'per_word',
  session_audio_path TEXT NULL,
  error_type TEXT NULL,
  session_audio_mime TEXT NULL,
  session_audio_uploaded_at TEXT NULL,
  FOREIGN KEY(user_id) REFERENCES lm_users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lm_session_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  word_id INTEGER NOT NULL,
  expected TEXT NOT NULL,
  recognized TEXT NULL,
  correct INTEGER NOT NULL CHECK(correct IN (0,1)),
  response_time_ms INTEGER NULL,
  visible_ms INTEGER NULL,
  start_ms INTEGER NULL,
  end_ms INTEGER NULL,
  error_type TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(session_id) REFERENCES lm_sessions(id) ON DELETE CASCADE
);

-- Optional: audit log (minimal)
CREATE TABLE IF NOT EXISTS lm_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NULL,
  event TEXT NOT NULL,
  meta_json TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(user_id) REFERENCES lm_users(id) ON DELETE SET NULL
);

-- Seed example group (optional)
INSERT INTO lm_groups (name)
SELECT 'Demo-gruppe' WHERE NOT EXISTS (SELECT 1 FROM lm_groups);


-- Student disputes / teacher reviews (optional audio evidence)
CREATE TABLE IF NOT EXISTS lm_disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_word_id INTEGER NOT NULL,
  session_id INTEGER NOT NULL,
  student_user_id INTEGER NOT NULL,
  expected TEXT NOT NULL,
  recognized TEXT NULL,
  note TEXT NULL,
  audio_path TEXT NULL,         -- relative path under backend/uploads
  error_type TEXT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')) DEFAULT 'pending',
  reviewed_by INTEGER NULL,
  reviewed_at TEXT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(session_word_id) REFERENCES lm_session_words(id) ON DELETE CASCADE,
  FOREIGN KEY(session_id) REFERENCES lm_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY(student_user_id) REFERENCES lm_users(id) ON DELETE CASCADE,
  FOREIGN KEY(reviewed_by) REFERENCES lm_users(id) ON DELETE SET NULL
);
