CREATE TABLE IF NOT EXISTS frosh_notes (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  task_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_notes_user_updated_idx
  ON frosh_notes (user_id, pinned DESC, updated_at DESC);
CREATE INDEX IF NOT EXISTS frosh_notes_user_task_idx
  ON frosh_notes (user_id, task_id)
  WHERE task_id IS NOT NULL;
