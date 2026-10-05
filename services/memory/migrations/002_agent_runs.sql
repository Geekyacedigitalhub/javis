CREATE TABLE IF NOT EXISTS frosh_agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','waiting_approval','completed','failed')),
  tool_calls JSONB NOT NULL DEFAULT '[]'::jsonb,
  pending_approval_id TEXT,
  result TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_agent_runs_status_idx ON frosh_agent_runs (status);
CREATE INDEX IF NOT EXISTS frosh_agent_runs_conversation_idx ON frosh_agent_runs (conversation_id, updated_at DESC);
