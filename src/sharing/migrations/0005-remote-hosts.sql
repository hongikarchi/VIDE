CREATE TABLE remote_hosts (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES user(id),
 name TEXT NOT NULL,
 secret TEXT NOT NULL,
 url TEXT,
 status TEXT,
 last_seen INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL
);
CREATE INDEX remote_hosts_user ON remote_hosts(user_id);
CREATE TABLE remote_host_pairings (
 code_hash TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES user(id),
 expires_at INTEGER NOT NULL
);
