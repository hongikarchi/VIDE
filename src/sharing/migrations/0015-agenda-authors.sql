-- SPEC-01.14 12, SPEC-04.10 2 (2026-10-08): who made each 할 일 and who changed it last. The PC's
-- copy keeps the account id and the name at the time (both null for items made before this, shown
-- as '작성자 정보 없음'); a waiting site edit keeps its author in user_id and, for an add another
-- member changed before the PC took it, the last editor in editor_id.
ALTER TABLE project_agenda ADD COLUMN created_by TEXT;
ALTER TABLE project_agenda ADD COLUMN created_by_name TEXT;
ALTER TABLE project_agenda ADD COLUMN updated_by TEXT;
ALTER TABLE project_agenda ADD COLUMN updated_by_name TEXT;
ALTER TABLE agenda_edits ADD COLUMN editor_id TEXT;
