CREATE TABLE IF NOT EXISTS frosh_http_monitors (
  id UUID PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 5 AND 1440),
  status TEXT NOT NULL CHECK (status IN ('active','paused')) DEFAULT 'active',
  health TEXT NOT NULL CHECK (health IN ('unknown','healthy','degraded','down')) DEFAULT 'unknown',
  next_check_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  last_healthy_at TIMESTAMPTZ,
  last_status_code INTEGER,
  last_latency_ms INTEGER,
  last_error TEXT,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_http_monitors_user_next_idx
  ON frosh_http_monitors (user_id, status, next_check_at);
CREATE INDEX IF NOT EXISTS frosh_http_monitors_due_idx
  ON frosh_http_monitors (next_check_at)
  WHERE status = 'active';

CREATE TABLE IF NOT EXISTS frosh_monitor_events (
  id UUID PRIMARY KEY,
  monitor_id UUID NOT NULL REFERENCES frosh_http_monitors(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('healthy','degraded','down','recovered')),
  health TEXT NOT NULL CHECK (health IN ('healthy','degraded','down')),
  message TEXT NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_monitor_events_monitor_created_idx
  ON frosh_monitor_events (monitor_id, user_id, created_at DESC);
