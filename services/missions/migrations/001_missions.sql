CREATE TABLE IF NOT EXISTS frosh_missions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planning','running','waiting_approval','completed','failed','paused')),
  progress DOUBLE PRECISION NOT NULL DEFAULT 0 CHECK (progress >= 0 AND progress <= 1),
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  active_run_id TEXT,
  pending_approval_id TEXT,
  result TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS frosh_missions_user_idx ON frosh_missions(user_id, status, updated_at DESC);
