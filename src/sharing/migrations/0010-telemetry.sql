-- ADR-036: opt-in error/performance reports from VIDE installs. Small anonymous summaries (a random
-- install id, versions, counts, scrubbed error lines, timings) in D1; diagnostic bundles the user
-- chose to send go to R2 only while the site switch is on, indexed here.
CREATE TABLE telemetry_reports (
 id TEXT PRIMARY KEY,
 install_id TEXT NOT NULL,
 version TEXT NOT NULL,
 kind TEXT NOT NULL,
 received_at INTEGER NOT NULL,
 day TEXT NOT NULL,
 size INTEGER NOT NULL,
 payload TEXT NOT NULL
);
CREATE INDEX telemetry_reports_day ON telemetry_reports(day,kind);
CREATE INDEX telemetry_reports_version ON telemetry_reports(version,received_at);
CREATE INDEX telemetry_reports_install ON telemetry_reports(install_id,received_at);
CREATE INDEX telemetry_reports_received ON telemetry_reports(received_at);
-- Daily counters for the endpoint's limits (per install and per address digest).
CREATE TABLE telemetry_limits (
 key TEXT PRIMARY KEY,
 window_start INTEGER NOT NULL,
 count INTEGER NOT NULL
);
CREATE TABLE telemetry_bundles (
 id TEXT PRIMARY KEY,
 install_id TEXT NOT NULL,
 version TEXT NOT NULL,
 received_at INTEGER NOT NULL,
 size INTEGER NOT NULL,
 object_key TEXT NOT NULL,
 dumps INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX telemetry_bundles_received ON telemetry_bundles(received_at);
