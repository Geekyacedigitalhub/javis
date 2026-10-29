-- Capacity checks count only runs that could still execute provider or approved
-- tool work. This partial index keeps that owner-scoped query bounded as run
-- history grows.
CREATE INDEX IF NOT EXISTS frosh_agent_runs_active_user_idx
  ON frosh_agent_runs (user_id)
  WHERE status IN ('running', 'waiting_approval');
