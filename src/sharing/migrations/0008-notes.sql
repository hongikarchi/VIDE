-- SPEC-10, ADR-034: shared project notes, 협의 사항 and the daily journal. The live document of a
-- note (Yjs updates) lives in its Durable Object (NoteRoom); this row is the list entry and a
-- Markdown snapshot for listing, search, the work PC's copy and the AI.
CREATE TABLE notes (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 title TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('note','discussion','journal')),
 journal_date TEXT,
 snapshot TEXT NOT NULL DEFAULT '',
 created_by TEXT NOT NULL REFERENCES user(id),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 updated_by TEXT,
 revision INTEGER NOT NULL DEFAULT 0,
 deleted_at INTEGER
);
CREATE INDEX notes_project ON notes(project_id,updated_at);
-- One journal entry per project and day.
CREATE UNIQUE INDEX notes_journal_day ON notes(project_id,journal_date) WHERE kind='journal' AND deleted_at IS NULL;
