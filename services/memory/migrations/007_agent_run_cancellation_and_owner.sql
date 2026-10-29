-- Agent runs predate authenticated owner scoping. Existing local histories belong
-- to the configured default owner, while all new writes supply an explicit owner.
ALTER TABLE frosh_agent_runs
  ADD COLUMN IF NOT EXISTS user_id TEXT NOT NULL DEFAULT 'default-user';

ALTER TABLE frosh_agent_runs
  DROP CONSTRAINT IF EXISTS frosh_agent_runs_status_check;

ALTER TABLE frosh_agent_runs
  ADD CONSTRAINT frosh_agent_runs_status_check
  CHECK (status IN ('running','waiting_approval','completed','failed','cancelled'));

CREATE INDEX IF NOT EXISTS frosh_agent_runs_user_created_idx
  ON frosh_agent_runs (user_id, created_at DESC);
