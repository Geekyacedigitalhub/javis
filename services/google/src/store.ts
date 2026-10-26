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

const GOOGLE_STORE_QUERY_TIMEOUT_MS = 8_000;

type PreferenceConnectionRow = { connection: unknown };
type PreferenceStateRow = { state: unknown };

type CancellableQuery = { cancel: () => void; state?: unknown };

/**
 * postgres.js exposes an active query's backend state at runtime. Its public
 * cancel() method deliberately returns void, even though cancelling an active
 * backend command starts another asynchronous connection. On a constrained
 * deployment, that secondary connection can fail after our response timeout
 * and become an unhandled rejection. Queued queries are safe to cancel (and
 * must be removed from the pool queue); active ones are already bounded by the
 * database statement timeout configured on the shared client.
 */
function isActivePostgresQuery(query: CancellableQuery): boolean {
  return Boolean(query.state);
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function connectionFromPreference(value: unknown, expectedUserId: string): FroshStoredGoogleConnection | null {
  const item = record(value);
  if (!item || item.userId !== expectedUserId || item.provider !== "google") return null;
  if (typeof item.encryptedTokenSet !== "string" || typeof item.status !== "string") return null;
  try {
    return toConnection({
      userId: item.userId,
      encryptedTokenSet: item.encryptedTokenSet,
      scopes: item.scopes,
      status: item.status === "reconnect_required" ? "reconnect_required" : "connected",
      accessTokenExpiresAt: typeof item.accessTokenExpiresAt === "string" ? item.accessTokenExpiresAt : "",
      connectedAt: typeof item.connectedAt === "string" ? item.connectedAt : "",
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
    });
  } catch {
    return null;
  }
}

function stateFromPreference(value: unknown, stateHash: string): FroshGoogleOAuthState | null {
  const item = record(value);
  if (!item || typeof item.userId !== "string" || typeof item.encryptedCodeVerifier !== "string" || typeof item.expiresAt !== "string") {
    return null;
  }
  try {
    return toState({
      stateHash,
      userId: item.userId,
      encryptedCodeVerifier: item.encryptedCodeVerifier,
      expiresAt: item.expiresAt,
    });
  } catch {
    return null;
  }
}

export class PostgresGoogleIntegrationStore implements FroshGoogleIntegrationStore {
  constructor(
    private readonly sql: Sql,
    private readonly queryTimeoutMs = GOOGLE_STORE_QUERY_TIMEOUT_MS,
  ) {}

  async close() {
    await this.sql.end({ timeout: 5 });
  }

  /**
   * Google credentials are kept in the durable preferences record, which is
   * already the API's proven user-scoped storage path. This avoids a separate
   * pool/table becoming a single point of failure on a constrained deployment.
   */
  private async query<T extends object = Record<string, never>>(
    statement: string,
    parameters: unknown[] = [],
  ): Promise<T[] & { count: number }> {
    const pending = this.sql.unsafe<T[]>(statement, parameters as never[]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("Google integration storage query timed out."));
            try {
              // Remove a queued operation so it cannot monopolize a later
              // request. Let active commands finish at PostgreSQL's configured
              // statement timeout instead of opening postgres.js's separate
              // cancellation connection after this HTTP response has ended.
              if (!isActivePostgresQuery(pending as CancellableQuery)) pending.cancel();
            } catch {
              // A queued client may not be cancellable yet; the caller still
              // receives the timeout instead of waiting forever.
            }
          }, this.queryTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getConnection(userId: string) {
    const id = validUserId(userId);
    const rows = await this.query<PreferenceConnectionRow>(
      `SELECT google_connection AS "connection"
       FROM frosh_user_preferences WHERE user_id=$1 LIMIT 1`,
      [id],
    );
    return rows[0] ? connectionFromPreference(rows[0].connection, id) : null;
  }

  async saveConnection(connection: FroshStoredGoogleConnection) {
    const userId = validUserId(connection.userId);
    if (!connection.encryptedTokenSet || connection.encryptedTokenSet.length > 32_000) {
      throw new Error("Google credentials are invalid.");
    }
    const stored: FroshStoredGoogleConnection = {
      ...connection,
      userId,
      provider: "google",
      status: connection.status === "reconnect_required" ? "reconnect_required" : "connected",
      scopes: asScopes(connection.scopes),
      accessTokenExpiresAt: asIsoDate(connection.accessTokenExpiresAt),
      connectedAt: asIsoDate(connection.connectedAt),
      updatedAt: asIsoDate(connection.updatedAt),
    };
    await this.query(
      `INSERT INTO frosh_user_preferences(user_id,google_connection)
       VALUES($1,$2::jsonb)
       ON CONFLICT (user_id) DO UPDATE SET google_connection=EXCLUDED.google_connection, updated_at=NOW()`,
      [userId, JSON.stringify(stored)],
    );
  }

  async markReconnectRequired(userId: string) {
    const current = await this.getConnection(userId);
    if (!current) return;
    await this.saveConnection({
      ...current,
      status: "reconnect_required",
      updatedAt: new Date().toISOString(),
    });
  }

  async deleteConnection(userId: string) {
    const result = await this.query(
      `UPDATE frosh_user_preferences
       SET google_connection=NULL, updated_at=NOW()
       WHERE user_id=$1 AND google_connection IS NOT NULL`,
      [validUserId(userId)],
    );
    return result.count > 0;
  }

  async createOAuthState(state: FroshGoogleOAuthState) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(state.stateHash)) throw new Error("OAuth state is invalid.");
    if (!state.encryptedCodeVerifier || state.encryptedCodeVerifier.length > 8_000) throw new Error("OAuth verifier is invalid.");
    const expiresAt = asIsoDate(state.expiresAt);
    const userId = validUserId(state.userId);
    const payload = JSON.stringify({ userId, encryptedCodeVerifier: state.encryptedCodeVerifier, expiresAt });
    await this.query(
      `INSERT INTO frosh_user_preferences(user_id,google_oauth_states)
       VALUES($1,jsonb_build_object($2::text,$3::jsonb))
       ON CONFLICT (user_id) DO UPDATE SET
         google_oauth_states=COALESCE(frosh_user_preferences.google_oauth_states,'{}'::jsonb)
           || jsonb_build_object($2::text,$3::jsonb),
         updated_at=NOW()`,
      [userId, state.stateHash, payload],
    );
  }

  async consumeOAuthState(stateHash: string) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(stateHash)) return null;
    const rows = await this.query<PreferenceStateRow>(
      `WITH matched AS (
         SELECT user_id, google_oauth_states -> $1::text AS state
         FROM frosh_user_preferences
         WHERE google_oauth_states ? $1::text
         FOR UPDATE
       )
       UPDATE frosh_user_preferences preferences
       SET google_oauth_states=preferences.google_oauth_states - $1::text, updated_at=NOW()
       FROM matched
       WHERE preferences.user_id=matched.user_id
       RETURNING matched.state AS "state"`,
      [stateHash],
    );
    return rows[0] ? stateFromPreference(rows[0].state, stateHash) : null;
  }
}
