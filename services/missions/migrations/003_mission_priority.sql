ALTER TABLE frosh_missions ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high'));
CREATE INDEX IF NOT EXISTS frosh_missions_priority_idx ON frosh_missions(user_id, status, priority, updated_at DESC);
