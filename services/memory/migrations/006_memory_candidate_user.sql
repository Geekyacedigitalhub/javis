ALTER TABLE frosh_memory_candidates
  ADD COLUMN IF NOT EXISTS user_id TEXT;

CREATE INDEX IF NOT EXISTS frosh_memory_candidates_user_status_idx
  ON frosh_memory_candidates (user_id, status, created_at DESC);
