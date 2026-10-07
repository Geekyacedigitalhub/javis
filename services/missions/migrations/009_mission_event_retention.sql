-- Bound mission event storage by retention age and per-mission count.
-- The existing (mission_id, created_at) index supports the cleanup query.
ALTER TABLE frosh_mission_events
  ADD CONSTRAINT frosh_mission_events_message_size_chk
  CHECK (octet_length(message) <= 16384);
