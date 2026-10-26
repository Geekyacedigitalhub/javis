CREATE TABLE IF NOT EXISTS frosh_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('open','in_progress','completed','cancelled')) DEFAULT 'open',
  priority TEXT NOT NULL CHECK (priority IN ('low','normal','high')) DEFAULT 'normal',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_tasks_user_status_due_idx
  ON frosh_tasks (user_id, status, due_at);
