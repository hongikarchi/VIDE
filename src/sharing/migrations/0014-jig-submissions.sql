-- ADR-041, SPEC-04.13: jig packs that users send from VIDE to the admins. The pack file is in R2
-- (`jig-submissions/<id>.vjig`); sha256 is computed here from the received bytes, pack_digest is
-- the content digest inside the pack. Status: received | reviewing | applied | rejected.
CREATE TABLE jig_submissions (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL,
 host_id TEXT,
 host_name TEXT,
 jig_id TEXT NOT NULL,
 version TEXT NOT NULL,
 name TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 size INTEGER NOT NULL,
 sha256 TEXT NOT NULL,
 pack_digest TEXT NOT NULL,
 object_key TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('received','reviewing','applied','rejected')),
 reason TEXT,
 reviewed_by TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX jig_submissions_user ON jig_submissions(user_id,created_at);
CREATE INDEX jig_submissions_status ON jig_submissions(status,created_at);
