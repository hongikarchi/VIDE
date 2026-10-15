-- PLAN-54 T-343 (SPEC-04.14, SPEC-07.11 공유 경로): 보고용 게시 — a 보고용 folder a PC put behind a
-- password link `/r/<id>/`. Files live in R2 ASSETS under `reports/<id>/<version>/`; r2_prefix is
-- the version served, pending_prefix the one being uploaded (a re-publish keeps the old one open
-- until it finishes). Only a salted PBKDF2 hash of the password is kept. revoked_at set = 404.
CREATE TABLE report_publications (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL,
 title TEXT NOT NULL,
 password_hash TEXT NOT NULL,
 password_salt TEXT NOT NULL,
 session_secret TEXT NOT NULL,
 r2_prefix TEXT,
 pending_prefix TEXT,
 file_count INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 published_at INTEGER,
 revoked_at INTEGER,
 published_by_host TEXT NOT NULL
);
CREATE INDEX report_publications_project ON report_publications(project_id);
