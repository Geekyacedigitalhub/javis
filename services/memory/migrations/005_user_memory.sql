CREATE TABLE IF NOT EXISTS frosh_user_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preference','commitment','relationship','project_context','important_fact')),
  statement TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_conversation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_user_memories_user_updated_idx
  ON frosh_user_memories (user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS frosh_user_memories_user_kind_idx
  ON frosh_user_memories (user_id, kind);
