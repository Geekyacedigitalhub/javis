-- Background requests enter a durable queue before provider work starts. A
-- queued row can survive a process restart because no provider/tool action has
-- been dispatched yet.
ALTER TABLE frosh_agent_runs
  DROP CONSTRAINT IF EXISTS frosh_agent_runs_status_check;
ALTER TABLE frosh_agent_runs
  ADD CONSTRAINT frosh_agent_runs_status_check
  CHECK (status IN ('queued','running','waiting_approval','completed','failed','cancelled'));

ALTER TABLE frosh_agent_run_events
  DROP CONSTRAINT IF EXISTS frosh_agent_run_events_status_check;
ALTER TABLE frosh_agent_run_events
  ADD CONSTRAINT frosh_agent_run_events_status_check
  CHECK (status IN ('queued','running','waiting_approval','completed','failed','cancelled'));
ALTER TABLE frosh_agent_run_events
  DROP CONSTRAINT IF EXISTS frosh_agent_run_events_type_check;
ALTER TABLE frosh_agent_run_events
  ADD CONSTRAINT frosh_agent_run_events_type_check
  CHECK (type IN ('created','queued','running','waiting_approval','completed','failed','cancelled'));

ALTER TABLE frosh_agent_run_checkpoints
  DROP CONSTRAINT IF EXISTS frosh_agent_run_checkpoints_status_check;
ALTER TABLE frosh_agent_run_checkpoints
  ADD CONSTRAINT frosh_agent_run_checkpoints_status_check
  CHECK (status IN ('queued','running','waiting_approval','completed','failed','cancelled'));

CREATE INDEX IF NOT EXISTS frosh_agent_runs_queued_user_idx
  ON frosh_agent_runs (user_id, created_at ASC)
  WHERE status = 'queued';

-- Existing triggers predate the queue. Keep their immutable audit guarantees
-- while recording a truthful queued transition instead of claiming execution
-- began at insertion time.
CREATE OR REPLACE FUNCTION frosh_record_agent_run_event()
RETURNS TRIGGER AS $$
DECLARE
  event_type TEXT;
  event_message TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  event_type := CASE
    WHEN TG_OP = 'INSERT' AND NEW.status = 'queued' THEN 'queued'
    WHEN TG_OP = 'INSERT' THEN 'created'
    ELSE NEW.status
  END;
  event_message := CASE
    WHEN TG_OP = 'INSERT' AND NEW.status = 'queued' THEN 'Run queued for durable background execution.'
    WHEN TG_OP = 'INSERT' THEN 'Agent run created.'
    WHEN NEW.status = 'waiting_approval' THEN 'FROSH is waiting for approval.'
    WHEN NEW.status = 'cancelled' THEN 'Run cancelled by the user.'
    WHEN NEW.status = 'completed' THEN 'Agent run completed.'
    WHEN NEW.status = 'failed' THEN COALESCE(NEW.error, 'Agent run failed.')
    ELSE 'Agent run is running.'
  END;

  INSERT INTO frosh_agent_run_events (run_id, user_id, type, status, message)
  VALUES (NEW.id, NEW.user_id, event_type, NEW.status, event_message);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION frosh_record_agent_run_checkpoint()
RETURNS TRIGGER AS $$
DECLARE
  checkpoint_kind TEXT;
  checkpoint_message TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    checkpoint_kind := 'created';
    checkpoint_message := CASE WHEN NEW.status = 'queued'
      THEN 'Checkpoint saved while background work is queued.'
      ELSE 'Checkpoint created before FROSH began work.' END;
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
