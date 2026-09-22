CREATE TABLE join_requests (
 id TEXT PRIMARY KEY,
 invitation_id TEXT NOT NULL REFERENCES invitations(id),
 user_id TEXT NOT NULL REFERENCES user(id),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_at INTEGER NOT NULL,
 decided_at INTEGER,
 decided_by TEXT REFERENCES user(id),
 UNIQUE(invitation_id,user_id)
);
CREATE INDEX join_requests_invitation ON join_requests(invitation_id,status);
