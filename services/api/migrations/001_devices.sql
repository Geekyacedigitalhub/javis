CREATE TABLE IF NOT EXISTS frosh_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android','windows','web')),
  status TEXT NOT NULL CHECK (status IN ('online','offline')),
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(name, platform)
);

CREATE TABLE IF NOT EXISTS frosh_device_credentials (
  device_id TEXT PRIMARY KEY REFERENCES frosh_devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS frosh_device_credentials_expiry_idx
  ON frosh_device_credentials(expires_at);
