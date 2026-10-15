-- PLAN-53 T-336 (SPEC-17.6, ARCH-01 §5 「프로젝트 기록」 사이트 사본): the 거른 기록 of a project
-- whose owner turned record sharing on, copied from the PC that runs it (PLAN-33's 할 일 copy: the
-- PC replaces its rows). Only kept records' date, type, text, part names and chapter; never
-- candidates, dropped ones, attachments, KakaoTalk or mail imports, or their originals. The site
-- does not show them yet. `parts` is a JSON array of part names.
CREATE TABLE project_records (
 project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
 record_id TEXT NOT NULL,
 date TEXT NOT NULL,
 type TEXT NOT NULL,
 text TEXT NOT NULL,
 parts TEXT NOT NULL DEFAULT '[]',
 chapter TEXT,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(project_id,record_id)
);
CREATE INDEX project_records_date ON project_records(project_id,date);
ALTER TABLE project_summaries ADD COLUMN records_at INTEGER;
