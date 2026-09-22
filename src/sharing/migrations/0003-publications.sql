ALTER TABLE projects ADD COLUMN current_publication_id TEXT;
CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  base_id TEXT,
  manifest TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading','published')),
  history_shared INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE(project_id,request_id)
);
CREATE INDEX publications_project ON publications(project_id,created_at);
CREATE TABLE comments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  publication_id TEXT NOT NULL REFERENCES publications(id),
  user_id TEXT NOT NULL REFERENCES user(id),
  submission_id TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  UNIQUE(project_id,user_id,submission_id)
);
CREATE INDEX comments_publication ON comments(publication_id,received_at,id);
