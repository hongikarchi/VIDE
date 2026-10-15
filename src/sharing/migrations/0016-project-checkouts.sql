-- PLAN-52 T-310 (SPEC-01.13 9, ARCH-01 「작업 폴더(PLAN-52)」): '작업 중' — which member's PC has a
-- server file of the project checked out. Each PC replaces only its own rows (pc_id = its remote
-- host id), like the 할 일 copy (0009); the PC keeps its full record in project.sqlite `checkouts`.
-- A row with released_at NULL is 작업 중. file_key is the server file's real path without case.
CREATE TABLE project_checkouts (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 file_key TEXT NOT NULL,
 role TEXT NOT NULL,
 server_path TEXT NOT NULL,
 pc_id TEXT NOT NULL,
 user_name TEXT NOT NULL,
 checked_out_at TEXT NOT NULL,
 released_at TEXT,
 PRIMARY KEY(project_id,pc_id,file_key)
);
CREATE INDEX project_checkouts_file ON project_checkouts(project_id,file_key);
