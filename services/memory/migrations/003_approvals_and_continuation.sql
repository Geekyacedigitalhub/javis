ALTER TABLE frosh_agent_runs
  ADD COLUMN IF NOT EXISTS provider_continuation JSONB;

CREATE TABLE IF NOT EXISTS frosh_approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT REFERENCES frosh_agent_runs(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  arguments JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS frosh_approvals_status_idx ON frosh_approvals(status);
CREATE INDEX IF NOT EXISTS frosh_approvals_run_idx ON frosh_approvals(run_id);
CREATE INDEX IF NOT EXISTS frosh_approvals_expires_idx ON frosh_approvals(expires_at);
