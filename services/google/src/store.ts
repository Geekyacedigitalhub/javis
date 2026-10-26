import postgres from "postgres";
import type {
  FroshGoogleConnectionStatus,
  FroshGoogleIntegrationStore,
  FroshGoogleOAuthState,
  FroshStoredGoogleConnection,
} from "../../../packages/types/src/google";

type Sql = ReturnType<typeof postgres>;

type ConnectionRow = {
  userId: string;
  encryptedTokenSet: string;
  scopes: unknown;
  status: FroshGoogleConnectionStatus;
  accessTokenExpiresAt: Date | string;
  connectedAt: Date | string;
  updatedAt: Date | string;
};

type StateRow = {
  stateHash: string;
  userId: string;
  encryptedCodeVerifier: string;
  expiresAt: Date | string;
};

function validUserId(value: string): string {
  const userId = typeof value === "string" ? value.trim() : "";
  if (!userId || userId.length > 200 || /[\u0000-\u001f\u007f]/.test(userId)) throw new Error("Invalid user ID");
  return userId;
}

function asIsoDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Google integration stored an invalid timestamp.");
  return date.toISOString();
}

function asScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 300).slice(0, 20);
}

function cloneConnection(connection: FroshStoredGoogleConnection): FroshStoredGoogleConnection {
  return { ...connection, scopes: [...connection.scopes] };
}

function cloneState(state: FroshGoogleOAuthState): FroshGoogleOAuthState {
  return { ...state };
}

function toConnection(row: ConnectionRow): FroshStoredGoogleConnection {
  return {
    userId: row.userId,
    provider: "google",
    encryptedTokenSet: row.encryptedTokenSet,
    scopes: asScopes(row.scopes),
    status: row.status === "reconnect_required" ? "reconnect_required" : "connected",
    accessTokenExpiresAt: asIsoDate(row.accessTokenExpiresAt),
    connectedAt: asIsoDate(row.connectedAt),
    updatedAt: asIsoDate(row.updatedAt),
  };
}

function toState(row: StateRow): FroshGoogleOAuthState | null {
  const expiresAt = asIsoDate(row.expiresAt);
  if (Date.parse(expiresAt) <= Date.now()) return null;
  return {
    stateHash: row.stateHash,
    userId: row.userId,
    encryptedCodeVerifier: row.encryptedCodeVerifier,
    expiresAt,
  };
}

export class InMemoryGoogleIntegrationStore implements FroshGoogleIntegrationStore {
  private readonly connections = new Map<string, FroshStoredGoogleConnection>();
  private readonly states = new Map<string, FroshGoogleOAuthState>();

  async getConnection(userId: string) {
    const current = this.connections.get(validUserId(userId));
    return current ? cloneConnection(current) : null;
  }

  async saveConnection(connection: FroshStoredGoogleConnection) {
    const userId = validUserId(connection.userId);
    if (!connection.encryptedTokenSet || connection.encryptedTokenSet.length > 32_000) {
      throw new Error("Google credentials are invalid.");
    }
    this.connections.set(userId, cloneConnection({ ...connection, userId, provider: "google", scopes: asScopes(connection.scopes) }));
  }

  async markReconnectRequired(userId: string) {
    const current = await this.getConnection(userId);
    if (!current) return;
    this.connections.set(current.userId, { ...current, status: "reconnect_required", updatedAt: new Date().toISOString() });
  }

  async deleteConnection(userId: string) {
    return this.connections.delete(validUserId(userId));
  }

  async createOAuthState(state: FroshGoogleOAuthState) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(state.stateHash)) throw new Error("OAuth state is invalid.");
    if (!state.encryptedCodeVerifier || state.encryptedCodeVerifier.length > 8_000) throw new Error("OAuth verifier is invalid.");
    if (!Number.isFinite(Date.parse(state.expiresAt))) throw new Error("OAuth state expiry is invalid.");
    this.states.set(state.stateHash, cloneState({ ...state, userId: validUserId(state.userId) }));
  }

  async consumeOAuthState(stateHash: string) {
    const state = this.states.get(stateHash);
    // Delete before inspecting expiry so malformed or expired callbacks cannot
    // be retried forever.
    this.states.delete(stateHash);
    if (!state || Date.parse(state.expiresAt) <= Date.now()) return null;
    return cloneState(state);
  }
}

export class PostgresGoogleIntegrationStore implements FroshGoogleIntegrationStore {
  constructor(private readonly sql: Sql) {}

  async close() {
    await this.sql.end({ timeout: 5 });
  }

  async getConnection(userId: string) {
    const rows = await this.sql.unsafe<ConnectionRow[]>(
      `SELECT user_id AS "userId", encrypted_token_set AS "encryptedTokenSet", scopes, status,
              access_token_expires_at AS "accessTokenExpiresAt", connected_at AS "connectedAt", updated_at AS "updatedAt"
       FROM frosh_google_connections WHERE user_id=$1 LIMIT 1`,
      [validUserId(userId)],
    );
    return rows[0] ? toConnection(rows[0]) : null;
  }

  async saveConnection(connection: FroshStoredGoogleConnection) {
    const userId = validUserId(connection.userId);
    if (!connection.encryptedTokenSet || connection.encryptedTokenSet.length > 32_000) {
      throw new Error("Google credentials are invalid.");
    }
    const expiresAt = asIsoDate(connection.accessTokenExpiresAt);
    const connectedAt = asIsoDate(connection.connectedAt);
    const scopes = asScopes(connection.scopes);
    await this.sql.unsafe(
      `INSERT INTO frosh_google_connections
        (user_id, encrypted_token_set, scopes, status, access_token_expires_at, connected_at, updated_at)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,NOW())
       ON CONFLICT (user_id) DO UPDATE SET encrypted_token_set=EXCLUDED.encrypted_token_set, scopes=EXCLUDED.scopes,
         status=EXCLUDED.status, access_token_expires_at=EXCLUDED.access_token_expires_at, updated_at=NOW()`,
      [userId, connection.encryptedTokenSet, JSON.stringify(scopes), connection.status, expiresAt, connectedAt],
    );
  }

  async markReconnectRequired(userId: string) {
    await this.sql.unsafe(
      `UPDATE frosh_google_connections SET status='reconnect_required', updated_at=NOW() WHERE user_id=$1`,
      [validUserId(userId)],
    );
  }

  async deleteConnection(userId: string) {
    const result = await this.sql.unsafe(`DELETE FROM frosh_google_connections WHERE user_id=$1`, [validUserId(userId)]);
    return result.count > 0;
  }

  async createOAuthState(state: FroshGoogleOAuthState) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(state.stateHash)) throw new Error("OAuth state is invalid.");
    if (!state.encryptedCodeVerifier || state.encryptedCodeVerifier.length > 8_000) throw new Error("OAuth verifier is invalid.");
    const expiresAt = asIsoDate(state.expiresAt);
    await this.sql.unsafe(
      `INSERT INTO frosh_google_oauth_states(state_hash,user_id,encrypted_code_verifier,expires_at)
       VALUES($1,$2,$3,$4)
       ON CONFLICT (state_hash) DO NOTHING`,
      [state.stateHash, validUserId(state.userId), state.encryptedCodeVerifier, expiresAt],
    );
  }

  async consumeOAuthState(stateHash: string) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(stateHash)) return null;
    const rows = await this.sql.unsafe<StateRow[]>(
      `DELETE FROM frosh_google_oauth_states WHERE state_hash=$1
       RETURNING state_hash AS "stateHash", user_id AS "userId", encrypted_code_verifier AS "encryptedCodeVerifier", expires_at AS "expiresAt"`,
      [stateHash],
    );
    return rows[0] ? toState(rows[0]) : null;
  }
}
