CREATE TABLE IF NOT EXISTS frosh_agent_run_events (
  id BIGSERIAL PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES frosh_agent_runs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('created','running','waiting_approval','completed','failed','cancelled')),
  status TEXT NOT NULL CHECK (status IN ('running','waiting_approval','completed','failed','cancelled')),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_agent_run_events_run_created_idx
  ON frosh_agent_run_events (run_id, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS frosh_agent_run_events_user_created_idx
  ON frosh_agent_run_events (user_id, created_at DESC);

-- Audit rows are written solely by the run-state trigger below. Application
-- code has no update/delete path, and this guard makes the database guarantee
-- that property too.
CREATE OR REPLACE FUNCTION frosh_agent_run_event_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'frosh_agent_run_events are append-only';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION frosh_record_agent_run_event()
RETURNS TRIGGER AS $$
DECLARE
  event_type TEXT;
  event_message TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  event_type := CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE NEW.status END;
  event_message := CASE
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

DROP TRIGGER IF EXISTS frosh_agent_run_event_trigger ON frosh_agent_runs;
CREATE TRIGGER frosh_agent_run_event_trigger
AFTER INSERT OR UPDATE ON frosh_agent_runs
FOR EACH ROW EXECUTE FUNCTION frosh_record_agent_run_event();

DROP TRIGGER IF EXISTS frosh_agent_run_event_immutable_trigger ON frosh_agent_run_events;
CREATE TRIGGER frosh_agent_run_event_immutable_trigger
BEFORE UPDATE OR DELETE ON frosh_agent_run_events
FOR EACH ROW EXECUTE FUNCTION frosh_agent_run_event_is_immutable();
