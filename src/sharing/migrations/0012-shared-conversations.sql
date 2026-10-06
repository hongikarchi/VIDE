-- PLAN-36 (ADR-037 4): the text of a project's conversations, mirrored from the PC that ran them.
-- The PC is the origin; the site keeps a text copy for every project member to read. Only
-- requests without a host document are mirrored (user adjustment 2026-10-06: modeling
-- conversations stay on the PC); no model geometry, attachments or pin coordinates. A request's
-- full record (request text, answer, activity lines, executed code, file names) is one JSON
-- document split into chunks under D1's row limit, never cut short (ADR-031). The origin PC
-- replaces and removes only its own rows.
CREATE TABLE shared_conversations (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 origin_host TEXT NOT NULL,
 id TEXT NOT NULL,
 origin_user TEXT NOT NULL,
 title TEXT NOT NULL,
 kind TEXT NOT NULL,
 provider TEXT,
 model TEXT,
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 stored_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,origin_host,id)
);
CREATE TABLE shared_requests (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 id TEXT NOT NULL,
 origin_host TEXT NOT NULL,
 origin_user TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 state TEXT NOT NULL,
 created_at TEXT NOT NULL,
 ended_at TEXT,
 files TEXT NOT NULL,
 preview TEXT NOT NULL,
 revision INTEGER NOT NULL,
 chunks INTEGER NOT NULL,
 size INTEGER NOT NULL,
 stored_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,id)
);
CREATE INDEX shared_requests_conversation ON shared_requests(project_id,origin_host,conversation_id,created_at);
CREATE INDEX shared_requests_stored ON shared_requests(project_id,stored_at);
CREATE TABLE shared_request_chunks (
 project_id TEXT NOT NULL,
 request_id TEXT NOT NULL,
 seq INTEGER NOT NULL,
 text TEXT NOT NULL,
 PRIMARY KEY(project_id,request_id,seq)
);
