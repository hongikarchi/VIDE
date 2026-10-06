-- PLAN-39 (SPEC-01.14 1, SPEC-04.10 2): the PC's 할 일 copy gains the period (end date, end time),
-- 위치 and 참석자. Existing rows have none until the PC uploads its list again. The kind column has
-- no CHECK, so 'receipt' (접수) needs no change here; the site maps a kind it does not know to 'task'.
ALTER TABLE project_agenda ADD COLUMN end_date TEXT;
ALTER TABLE project_agenda ADD COLUMN end_time TEXT;
ALTER TABLE project_agenda ADD COLUMN location TEXT;
ALTER TABLE project_agenda ADD COLUMN attendees TEXT;
