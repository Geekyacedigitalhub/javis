CREATE TABLE IF NOT EXISTS frosh_automations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  schedule JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','completed')),
  next_run_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_automations_user_idx
  ON frosh_automations (user_id, status, next_run_at);
