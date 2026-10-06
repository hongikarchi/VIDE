-- PLAN-33: a project opens on the site while its work PC is off. The PC keeps a copy of the
-- project's 할 일 here and a summary of its work history (request text, the answer's first lines,
-- state, time, file names; no model, no attachments, ADR-035). 할 일 edits made on the site wait
-- in agenda_edits until the PC applies them. Notes are PLAN-32's (0008) and not here.
CREATE TABLE project_agenda (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 item_id TEXT NOT NULL,
 text TEXT NOT NULL,
 date TEXT,
 time TEXT,
 kind TEXT NOT NULL,
 done_at TEXT,
 ord REAL NOT NULL,
 revision INTEGER NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(project_id,item_id)
);
CREATE TABLE project_summaries (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 agenda_revision INTEGER NOT NULL DEFAULT 0,
 agenda_at INTEGER,
 history_at INTEGER
);
CREATE TABLE agenda_edits (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES user(id),
 item_id TEXT NOT NULL,
 op TEXT NOT NULL CHECK(op IN ('add','set','remove')),
 fields TEXT NOT NULL,
 base_revision INTEGER,
 edited_at INTEGER NOT NULL,
 applied_at INTEGER,
 outcome TEXT
);
CREATE INDEX agenda_edits_project ON agenda_edits(project_id,applied_at,edited_at);
CREATE TABLE project_history (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 request_id TEXT NOT NULL,
 ord INTEGER NOT NULL,
 body TEXT NOT NULL,
 answer TEXT,
 state TEXT NOT NULL,
 files TEXT NOT NULL,
 created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,request_id)
);
