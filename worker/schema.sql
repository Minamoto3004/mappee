-- D1 (SQLite) — signalements Mappee
CREATE TABLE IF NOT EXISTS reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  toilet_id   TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('clean','ok','dirty','out_of_service')),
  comment     TEXT CHECK (comment IS NULL OR length(comment) <= 140),
  device_hash TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible','pending','rejected')),
  created_at  INTEGER NOT NULL                -- epoch secondes
);
CREATE INDEX IF NOT EXISTS reports_toilet_ix ON reports (toilet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_device_ix ON reports (device_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS reports_recent_ix ON reports (created_at) WHERE status = 'visible';
