CREATE TABLE IF NOT EXISTS frosh_conversation_memories (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  participant TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  key_facts JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_message_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_conversation_memories_updated_idx
  ON frosh_conversation_memories (updated_at DESC);

CREATE INDEX IF NOT EXISTS frosh_conversation_memories_participant_idx
  ON frosh_conversation_memories (provider, participant);

CREATE TABLE IF NOT EXISTS frosh_memory_candidates (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  statement TEXT NOT NULL,
  confidence DOUBLE PRECISION NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_conversation_id TEXT,
  source_message_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS frosh_memory_candidates_status_idx
  ON frosh_memory_candidates (status, created_at DESC);
