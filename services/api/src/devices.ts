import postgres from "postgres";
import type { FroshDevice, FroshDeviceRegistration } from "../../../packages/types/src/device";
import type { FroshCapabilityStatus } from "../../../packages/types/src/capabilities";

type DeviceCredential = { token: string; expiresAt: number };
type DeviceRow = FroshDevice & { createdAt?: string };

const devices = new Map<string, FroshDevice>();
const credentials = new Map<string, DeviceCredential>();
let sql: ReturnType<typeof postgres> | null | undefined;
let schemaPromise: Promise<void> | undefined;
let schemaReady = false;

function db() {
  if (sql !== undefined) return sql;
  const url = process.env.DATABASE_URL?.trim();
  sql = url ? postgres(url, { max: 5, idle_timeout: 20 }) : null;
  return sql;
}

async function ensureSchema() {
  if (!db()) return;
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const client = db()!;
      await client.unsafe(`CREATE TABLE IF NOT EXISTS frosh_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('android','windows','web')),
        status TEXT NOT NULL CHECK (status IN ('online','offline')),
        capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(name, platform)
      )`);
      await client.unsafe(`CREATE TABLE IF NOT EXISTS frosh_device_credentials (
        device_id TEXT PRIMARY KEY REFERENCES frosh_devices(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.unsafe(`CREATE INDEX IF NOT EXISTS frosh_device_credentials_expiry_idx ON frosh_device_credentials(expires_at)`);
      await client.unsafe(`CREATE TABLE IF NOT EXISTS frosh_device_command_ledger (
        request_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL REFERENCES frosh_devices(id) ON DELETE CASCADE,
        command TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','dispatched','completed','unknown')),
        accepted BOOLEAN,
        message TEXT,
        data JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        dispatched_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await client.unsafe(`CREATE INDEX IF NOT EXISTS frosh_device_command_ledger_device_idx ON frosh_device_command_ledger(device_id,created_at)`);
    })().catch(error => {
      schemaPromise = undefined;
      schemaReady = false;
      throw error;
    });
  }
  await schemaPromise;
  schemaReady = true;
}

async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeDevice(row: DeviceRow): FroshDevice {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    status: row.status,
    capabilities: row.capabilities,
    lastSeenAt: row.lastSeenAt,
  };
}

export async function initializeDeviceStore() {
  if (!db()) return;
  await ensureSchema();
  if (!schemaReady) throw new Error("Device store schema initialization failed");
}

export async function closeDeviceStore() {
  const client = sql;
  sql = undefined;
  schemaPromise = undefined;
  schemaReady = false;
  memoryCommandLedger.clear();
  if (!client) return;
  await client.end({ timeout: 5 });
}

export async function registerDevice(input: FroshDeviceRegistration, options: { allowExisting?: boolean } = {}) {
  const client = db();
  if (!client) {
    const now = new Date().toISOString();
    const existing = [...devices.values()].find(device => device.name === input.name && device.platform === input.platform);
    if (existing && !options.allowExisting) throw new Error("A device with this name and platform is already registered.");
    const device: FroshDevice = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name,
      platform: input.platform,
      status: "online",
      capabilities: [...new Set(input.capabilities)],
      lastSeenAt: now,
    };
    devices.set(device.id, device);
    return device;
  }
  await ensureSchema();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  if (!options.allowExisting) {
    const existing = await client.unsafe<{ id: string }[]>(
      `SELECT id FROM frosh_devices WHERE name=$1 AND platform=$2 LIMIT 1`,
      [input.name, input.platform],
    );
    if (existing[0]) throw new Error("A device with this name and platform is already registered.");
  }
  const rows = options.allowExisting
    ? await client.unsafe<FroshDevice[]>(
        `INSERT INTO frosh_devices(id,name,platform,status,capabilities,last_seen_at)
         VALUES($1,$2,$3,'online',$4::jsonb,$5)
         ON CONFLICT(name,platform) DO UPDATE SET status='online',capabilities=EXCLUDED.capabilities,last_seen_at=EXCLUDED.last_seen_at
         RETURNING id,name,platform,status,capabilities,last_seen_at AS "lastSeenAt"`,
        [id, input.name, input.platform, JSON.stringify([...new Set(input.capabilities)]), now],
      )
    : await client.unsafe<FroshDevice[]>(
        `INSERT INTO frosh_devices(id,name,platform,status,capabilities,last_seen_at)
         VALUES($1,$2,$3,'online',$4::jsonb,$5)
         RETURNING id,name,platform,status,capabilities,last_seen_at AS "lastSeenAt"`,
        [id, input.name, input.platform, JSON.stringify([...new Set(input.capabilities)]), now],
      );
  return rows[0];
}

export async function listDevices() {
  const client = db();
  if (!client) return [...devices.values()];
  await ensureSchema();
  return client.unsafe<FroshDevice[]>(`SELECT id,name,platform,status,capabilities,last_seen_at AS "lastSeenAt" FROM frosh_devices ORDER BY created_at ASC`);
}

export async function getDevice(id: string) {
  const client = db();
  if (!client) return devices.get(id) ?? null;
  await ensureSchema();
  const rows = await client.unsafe<FroshDevice[]>(`SELECT id,name,platform,status,capabilities,last_seen_at AS "lastSeenAt" FROM frosh_devices WHERE id=$1 LIMIT 1`, [id]);
  return rows[0] ?? null;
}

export async function markAllDevicesOffline() {
  const client = db();
  if (!client) {
    for (const [id, device] of devices) {
      devices.set(id, { ...device, status: "offline" });
    }
    return;
  }
  await ensureSchema();
  await client.unsafe(`UPDATE frosh_devices SET status='offline'`);
}

export async function markDeviceOffline(id: string) {
  const client = db();
  if (!client) {
    const device = devices.get(id);
    if (!device) return null;
    const updated = { ...device, status: "offline" as const };
    devices.set(id, updated);
    return updated;
  }
  await ensureSchema();
  const rows = await client.unsafe<FroshDevice[]>(`UPDATE frosh_devices SET status='offline' WHERE id=$1 RETURNING id,name,platform,status,capabilities,last_seen_at AS "lastSeenAt"`, [id]);
  return rows[0] ?? null;
}

export async function issueDeviceCredential(deviceId: string) {
  const client = db();
  const device = client ? await getDevice(deviceId) : devices.get(deviceId);
  if (!device) return null;
  const token = `${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const configuredTtl = Number(process.env.FROSH_DEVICE_CREDENTIAL_TTL_MS ?? 30 * 24 * 60 * 60 * 1000);
  const ttlMs = Number.isFinite(configuredTtl)
    ? Math.min(90 * 24 * 60 * 60 * 1000, Math.max(5 * 60 * 1000, Math.floor(configuredTtl)))
    : 30 * 24 * 60 * 60 * 1000;
  const expiresAt = Date.now() + ttlMs;
  if (!client) {
    credentials.set(deviceId, { token, expiresAt });
  } else {
    await ensureSchema();
    await client.unsafe(
      `INSERT INTO frosh_device_credentials(device_id,token_hash,expires_at,updated_at)
       VALUES($1,$2,$3,NOW())
       ON CONFLICT(device_id) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at,updated_at=NOW()`,
      [deviceId, await hashToken(token), new Date(expiresAt).toISOString()],
    );
  }

  // Credential replacement invalidates every existing realtime session immediately.
  // Do this after durable credential replacement so no old session remains trusted.
  const { disconnectDeviceClients } = await import("./realtime");
  disconnectDeviceClients(deviceId);

  return { deviceId, token, expiresAt: new Date(expiresAt).toISOString() };
}


export type DeviceCommandLedgerState = "pending" | "dispatched" | "completed" | "unknown";

export type DeviceCommandLedgerRecord = {
  requestId: string;
  deviceId: string;
  command: string;
  payloadHash: string;
  state: DeviceCommandLedgerState;
  accepted?: boolean;
  message?: string;
  data?: unknown;
  createdAt: string;
  dispatchedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

function normalizeCommandLedgerRow(row: {
  requestId: string;
  deviceId: string;
  command: string;
  payloadHash: string;
  state: DeviceCommandLedgerState;
  accepted: boolean | null;
  message: string | null;
  data: unknown;
  createdAt: string;
  dispatchedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}): DeviceCommandLedgerRecord {
  return {
    requestId: row.requestId,
    deviceId: row.deviceId,
    command: row.command,
    payloadHash: row.payloadHash,
    state: row.state,
    ...(row.accepted === null ? {} : { accepted: row.accepted }),
    ...(row.message === null ? {} : { message: row.message }),
    ...(row.data === null ? {} : { data: row.data }),
    createdAt: row.createdAt,
    ...(row.dispatchedAt ? { dispatchedAt: row.dispatchedAt } : {}),
    ...(row.completedAt ? { completedAt: row.completedAt } : {}),
    updatedAt: row.updatedAt,
  };
}

const memoryCommandLedger = new Map<string, DeviceCommandLedgerRecord>();

export async function createDeviceCommandLedger(input: {
  requestId: string;
  deviceId: string;
  command: string;
  payloadHash: string;
}) {
  const client = db();
  const now = new Date().toISOString();
  if (!client) {
    if (memoryCommandLedger.has(input.requestId)) return false;
    memoryCommandLedger.set(input.requestId, {
      ...input,
      state: "pending",
      createdAt: now,
      updatedAt: now,
    });
    return true;
  }
  await ensureSchema();
  const result = await client.unsafe(
    `INSERT INTO frosh_device_command_ledger(request_id,device_id,command,payload_hash,state,created_at,updated_at)
     VALUES($1,$2,$3,$4,'pending',NOW(),NOW())
     ON CONFLICT(request_id) DO NOTHING`,
    [input.requestId, input.deviceId, input.command, input.payloadHash],
  );
  return result.count > 0;
}

export async function markDeviceCommandDispatched(requestId: string) {
  const client = db();
  const now = new Date().toISOString();
  if (!client) {
    const record = memoryCommandLedger.get(requestId);
    if (!record || record.state !== "pending") return false;
    memoryCommandLedger.set(requestId, { ...record, state: "dispatched", dispatchedAt: now, updatedAt: now });
    return true;
  }
  await ensureSchema();
  const result = await client.unsafe(
    `UPDATE frosh_device_command_ledger
     SET state='dispatched',dispatched_at=COALESCE(dispatched_at,NOW()),updated_at=NOW()
     WHERE request_id=$1 AND state='pending'`,
    [requestId],
  );
  return result.count > 0;
}

export async function completeDeviceCommandLedger(requestId: string, result: { accepted: boolean; message: string; data?: unknown }) {
  const client = db();
  const now = new Date().toISOString();
  if (!client) {
    const record = memoryCommandLedger.get(requestId);
    if (!record || (record.state !== "pending" && record.state !== "dispatched")) return false;
    memoryCommandLedger.set(requestId, {
      ...record,
      state: "completed",
      accepted: result.accepted,
      message: result.message,
      ...(result.data === undefined ? {} : { data: result.data }),
      completedAt: now,
      updatedAt: now,
    });
    return true;
  }
  await ensureSchema();
  const resultRow = await client.unsafe(
    `UPDATE frosh_device_command_ledger
     SET state='completed',accepted=$2,message=$3,data=$4::jsonb,completed_at=COALESCE(completed_at,NOW()),updated_at=NOW()
     WHERE request_id=$1 AND state IN ('pending','dispatched')
     RETURNING request_id`,
    [requestId, result.accepted, result.message, JSON.stringify(result.data ?? null)],
  );
  return resultRow.count > 0;
}

export async function markDeviceCommandUnknown(requestId: string, reason?: string) {
  const client = db();
  const now = new Date().toISOString();
  if (!client) {
    const record = memoryCommandLedger.get(requestId);
    if (!record || record.state === "completed" || record.state === "unknown") return false;
    memoryCommandLedger.set(requestId, {
      ...record,
      state: "unknown",
      ...(reason ? { message: reason } : {}),
      updatedAt: now,
    });
    return true;
  }
  await ensureSchema();
  const result = await client.unsafe(
    `UPDATE frosh_device_command_ledger
     SET state='unknown',message=COALESCE($2,message),updated_at=NOW()
     WHERE request_id=$1 AND state IN ('pending','dispatched')`,
    [requestId, reason ?? null],
  );
  return result.count > 0;
}

export async function getDeviceCommandLedger(requestId: string) {
  const client = db();
  if (!client) return memoryCommandLedger.get(requestId) ?? null;
  await ensureSchema();
  const rows = await client.unsafe<{
    requestId: string;
    deviceId: string;
    command: string;
    payloadHash: string;
    state: DeviceCommandLedgerState;
    accepted: boolean | null;
    message: string | null;
    data: unknown;
    createdAt: string;
    dispatchedAt: string | null;
    completedAt: string | null;
    updatedAt: string;
  }[]>(
    `SELECT request_id AS "requestId",device_id AS "deviceId",command,payload_hash AS "payloadHash",state,accepted,message,data,
            created_at AS "createdAt",dispatched_at AS "dispatchedAt",completed_at AS "completedAt",updated_at AS "updatedAt"
     FROM frosh_device_command_ledger WHERE request_id=$1 LIMIT 1`,
    [requestId],
  );
  return rows[0] ? normalizeCommandLedgerRow(rows[0]) : null;
}

export async function purgeExpiredDeviceCredentials() {
  const client = db();
  if (!client) {
    const now = Date.now();
    for (const [deviceId, credential] of credentials) {
      if (credential.expiresAt <= now) credentials.delete(deviceId);
    }
    return;
  }
  await ensureSchema();
  await client.unsafe(`DELETE FROM frosh_device_credentials WHERE expires_at <= NOW()`);
}

export async function revokeDeviceCredential(deviceId: string) {
  const client = db();
  if (!client) {
    if (!devices.has(deviceId)) return false;
    return credentials.delete(deviceId);
  }
  await ensureSchema();
  const result = await client.unsafe(`DELETE FROM frosh_device_credentials WHERE device_id=$1`, [deviceId]);
  return result.count > 0;
}

export async function authenticateDevice(deviceId: string, token: string) {
  const client = db();
  if (!client) {
    const credential = credentials.get(deviceId);
    if (!credential || credential.expiresAt <= Date.now() || credential.token !== token) return false;
    const device = devices.get(deviceId);
    if (!device) return false;
    devices.set(deviceId, { ...device, status: "online", lastSeenAt: new Date().toISOString() });
    return true;
  }
  await ensureSchema();
  const tokenHash = await hashToken(token);
  const updated = await client.unsafe(
    `UPDATE frosh_devices
     SET status='online',last_seen_at=NOW()
     WHERE id=$1
       AND EXISTS (
         SELECT 1
         FROM frosh_device_credentials
         WHERE device_id=$1
           AND token_hash=$2
           AND expires_at>NOW()
       )
     RETURNING id`,
    [deviceId, tokenHash],
  );
  return updated.count > 0;
}

export async function updateDeviceCapabilities(deviceId: string, capabilities: FroshCapabilityStatus[]) {
  const client = db();
  const normalized = capabilities.filter(item => item.availability === "available").map(item => item.capability);
  if (!client) {
    const device = devices.get(deviceId);
    if (!device) return null;
    const updated = { ...device, capabilities: normalized, lastSeenAt: new Date().toISOString(), status: "online" as const };
    devices.set(deviceId, updated);
    return updated;
  }
  await ensureSchema();
  const rows = await client.unsafe<FroshDevice[]>(
    `UPDATE frosh_devices SET capabilities=$2::jsonb,last_seen_at=NOW(),status='online' WHERE id=$1
     RETURNING id,name,platform,status,capabilities,last_seen_at AS "lastSeenAt"`,
    [deviceId, JSON.stringify(normalized)],
  );
  return rows[0] ?? null;
}
