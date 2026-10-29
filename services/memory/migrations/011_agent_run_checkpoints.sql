-- Compact, immutable task snapshots complement status events. They preserve the
-- operator-relevant stopping point without storing prompts, provider state, or
-- tool arguments that might contain sensitive data.
CREATE TABLE IF NOT EXISTS frosh_agent_run_checkpoints (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES frosh_agent_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created','running','awaiting_approval','approval_resumed','tool_evidence','completed','failed','cancelled')),
  status TEXT NOT NULL CHECK (status IN ('running','waiting_approval','completed','failed','cancelled')),
  message TEXT NOT NULL,
  tool_call_count INTEGER NOT NULL CHECK (tool_call_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_agent_run_checkpoints_run_created_idx
  ON frosh_agent_run_checkpoints (run_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS frosh_agent_run_checkpoints_user_created_idx
  ON frosh_agent_run_checkpoints (user_id, created_at DESC);

CREATE OR REPLACE FUNCTION frosh_record_agent_run_checkpoint()
RETURNS TRIGGER AS $$
DECLARE
  checkpoint_kind TEXT;
  checkpoint_message TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    checkpoint_kind := 'created';
    checkpoint_message := 'Checkpoint created before FROSH began work.';
  ELSIF NEW.status = 'waiting_approval' THEN
    checkpoint_kind := 'awaiting_approval';
    checkpoint_message := 'Checkpoint saved while FROSH waits for approval.';
  ELSIF OLD.status = 'waiting_approval' AND NEW.status = 'running' THEN
    checkpoint_kind := 'approval_resumed';
    checkpoint_message := 'Checkpoint saved after approval; execution resumed.';
  ELSIF NEW.status IN ('completed', 'failed', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    checkpoint_kind := NEW.status;
    checkpoint_message := CASE NEW.status
      WHEN 'completed' THEN 'Checkpoint saved when the run completed.'
      WHEN 'cancelled' THEN 'Checkpoint saved when the run was cancelled.'
      ELSE 'Checkpoint saved when the run stopped safely.'
    END;
  ELSIF NEW.tool_calls IS DISTINCT FROM OLD.tool_calls THEN
    checkpoint_kind := 'tool_evidence';
    checkpoint_message := 'Checkpoint saved after tool evidence changed.';
  ELSIF NEW.pending_approval_id IS DISTINCT FROM OLD.pending_approval_id OR NEW.status IS DISTINCT FROM OLD.status THEN
    checkpoint_kind := 'running';
    checkpoint_message := 'Checkpoint saved while FROSH continued work.';
  ELSE
    RETURN NEW;
  END IF;

  INSERT INTO frosh_agent_run_checkpoints (run_id, user_id, kind, status, message, tool_call_count)
  VALUES (NEW.id, NEW.user_id, checkpoint_kind, NEW.status, checkpoint_message, jsonb_array_length(NEW.tool_calls));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS frosh_agent_run_checkpoint_trigger ON frosh_agent_runs;
CREATE TRIGGER frosh_agent_run_checkpoint_trigger
AFTER INSERT OR UPDATE ON frosh_agent_runs
FOR EACH ROW EXECUTE FUNCTION frosh_record_agent_run_checkpoint();

CREATE OR REPLACE FUNCTION frosh_agent_run_checkpoint_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'frosh_agent_run_checkpoints are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS frosh_agent_run_checkpoint_immutable_trigger ON frosh_agent_run_checkpoints;
CREATE TRIGGER frosh_agent_run_checkpoint_immutable_trigger
BEFORE UPDATE OR DELETE ON frosh_agent_run_checkpoints
FOR EACH ROW EXECUTE FUNCTION frosh_agent_run_checkpoint_is_immutable();
