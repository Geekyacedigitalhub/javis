-- A client may retry a timed-out POST, but that must not start a second model
-- request or replay a tool action. Keys are scoped to the durable run owner.
ALTER TABLE frosh_agent_runs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS frosh_agent_runs_user_idempotency_key_idx
  ON frosh_agent_runs (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
