-- PLAN-35 (ADR-037 1-3): the team's shared project layer. The project AI instructions and the
-- organized project knowledge (statements, issues, briefs, and people's reviews and source
-- exclusion rules) live here; every project member reads and writes them. The crawler's result
-- arrives from the PC that crawled as one numbered set of rows (knowledge_rows); a new set becomes
-- visible only when its upload is committed. Source documents stay on the PCs.
CREATE TABLE project_instructions (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 text TEXT NOT NULL,
 revision INTEGER NOT NULL,
 edited_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 updated_by TEXT REFERENCES user(id) ON DELETE SET NULL
);
CREATE TABLE knowledge_sets (
 project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0,
 pending_revision INTEGER,
 built_at TEXT,
 counts TEXT NOT NULL DEFAULT '{}',
 host_id TEXT,
 updated_at INTEGER NOT NULL,
 updated_by TEXT REFERENCES user(id) ON DELETE SET NULL
);
CREATE TABLE knowledge_rows (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 tbl TEXT NOT NULL,
 row_key TEXT NOT NULL,
 body TEXT NOT NULL,
 PRIMARY KEY(project_id,revision,tbl,row_key)
);
CREATE TABLE knowledge_reviews (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 statement_id INTEGER NOT NULL,
 verdict TEXT,
 correction TEXT,
 superseded_by INTEGER,
 reason TEXT,
 by_name TEXT NOT NULL,
 edited_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 updated_by TEXT REFERENCES user(id) ON DELETE SET NULL,
 PRIMARY KEY(project_id,statement_id)
);
CREATE INDEX knowledge_reviews_changed ON knowledge_reviews(project_id,updated_at);
CREATE TABLE knowledge_rules (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 pattern TEXT NOT NULL,
 reason TEXT,
 removed INTEGER NOT NULL DEFAULT 0,
 edited_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 updated_by TEXT REFERENCES user(id) ON DELETE SET NULL,
 PRIMARY KEY(project_id,pattern)
);
CREATE INDEX knowledge_rules_changed ON knowledge_rules(project_id,updated_at);
