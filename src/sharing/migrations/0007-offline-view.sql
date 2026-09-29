-- PLAN-20: while the work PC is off, the account site shows the last saved view of each linked
-- file (geometry only, uploaded by the PC when the owner turned it on) and keeps requests that the
-- PC picks up when it comes back.
CREATE TABLE project_snapshots (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 link_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES user(id),
 name TEXT NOT NULL,
 host TEXT NOT NULL,
 size INTEGER NOT NULL,
 object_count INTEGER NOT NULL,
 captured_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(project_id,link_id)
);
CREATE INDEX project_snapshots_user ON project_snapshots(user_id);
CREATE TABLE queued_requests (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES user(id),
 host_id TEXT NOT NULL,
 link_id TEXT,
 body TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 delivered_at INTEGER,
 canceled_at INTEGER
);
CREATE INDEX queued_requests_host ON queued_requests(host_id,delivered_at,created_at);
CREATE INDEX queued_requests_project ON queued_requests(project_id,created_at);
