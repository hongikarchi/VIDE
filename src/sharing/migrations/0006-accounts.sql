-- Account workspace: projects are listed per account and remember the work PC that holds them.
ALTER TABLE projects ADD COLUMN updated_at INTEGER;
ALTER TABLE projects ADD COLUMN host_id TEXT;
ALTER TABLE projects ADD COLUMN deleted_at INTEGER;
ALTER TABLE projects ADD COLUMN thumbnail TEXT;
ALTER TABLE remote_hosts ADD COLUMN local_url TEXT;
DROP TABLE remote_host_pairings;
