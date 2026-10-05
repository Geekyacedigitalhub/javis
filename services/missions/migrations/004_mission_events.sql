CREATE TABLE IF NOT EXISTS frosh_mission_events (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL REFERENCES frosh_missions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  step_id TEXT,
  run_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS frosh_mission_events_mission_idx ON frosh_mission_events(mission_id, created_at DESC);
