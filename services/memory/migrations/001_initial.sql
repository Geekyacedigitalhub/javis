CREATE TABLE IF NOT EXISTS javis_conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS javis_conversations_user_id_idx ON javis_conversations (user_id);

CREATE TABLE IF NOT EXISTS javis_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES javis_conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS javis_messages_conversation_created_idx ON javis_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS javis_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('preference', 'fact', 'project', 'task')),
  content TEXT NOT NULL,
  importance DOUBLE PRECISION NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS javis_memories_user_importance_idx ON javis_memories (user_id, importance DESC, updated_at DESC);
