-- Store how the run was driven so a user-requested fresh retry can preserve
-- its strategy without carrying forward provider continuation or tool state.
ALTER TABLE frosh_agent_runs
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'session';

ALTER TABLE frosh_agent_runs
  DROP CONSTRAINT IF EXISTS frosh_agent_runs_mode_check;

ALTER TABLE frosh_agent_runs
  ADD CONSTRAINT frosh_agent_runs_mode_check
  CHECK (mode IN ('session', 'loop'));
