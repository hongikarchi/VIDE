-- SPEC-10.9 1, PLAN-54 T-356: 회의록 (kind 'meeting') joins the shared notes. SQLite cannot widen a
-- CHECK in place, so the table is made again with the same columns and its indexes after it.
-- (0018 is PLAN-53's project records.) Nothing references notes(id), so the swap keeps every row.
CREATE TABLE notes_next (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('note','discussion','journal','meeting')),
 journal_date TEXT,
 snapshot TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL REFERENCES user(id),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 updated_by TEXT,
 revision INTEGER NOT NULL DEFAULT 0,
 deleted_at INTEGER
);
INSERT INTO notes_next (id,project_id,title,kind,journal_date,snapshot,created_by,created_at,updated_at,updated_by,revision,deleted_at)
 SELECT id,project_id,title,kind,journal_date,snapshot,created_by,created_at,updated_at,updated_by,revision,deleted_at FROM notes;
DROP TABLE notes;
ALTER TABLE notes_next RENAME TO notes;
CREATE INDEX notes_project ON notes(project_id,updated_at);
-- One journal entry per project and day.
CREATE UNIQUE INDEX notes_journal_day ON notes(project_id,journal_date) WHERE kind='journal' AND deleted_at IS NULL;
