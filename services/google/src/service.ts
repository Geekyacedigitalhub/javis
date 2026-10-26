import type {
  FroshGmailMessageSummary,
  FroshGoogleCalendarEvent,
  FroshGoogleConnection,
  FroshGoogleIntegrationStore,
  FroshStoredGoogleConnection,
} from "../../../packages/types/src/google";
import {
  decryptGoogleSecret,
  encryptGoogleSecret,
  randomOpaqueToken,
  sha256Base64Url,
  tokenEncryptionKeyFromEnvironment,
} from "./crypto";

export const GOOGLE_REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;

const MAX_REMOTE_JSON_BYTES = 1_000_000;
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const TOKEN_REFRESH_SKEW_MS = 90_000;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const CONNECTION_STATUS_TIMEOUT_MS = 12_000;

type GoogleTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  tokenType: "Bearer";
};

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Environment = Record<string, string | undefined>;

export class GoogleIntegrationError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly code: "not_configured" | "not_connected" | "reconnect_required" | "authorization_failed" | "upstream_failed" | "invalid_input",
  ) {
    super(message);
    this.name = "GoogleIntegrationError";
  }
}

type GoogleOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: Uint8Array;
};

function requiredEnvironment(env: Environment, name: string): string {
  const value = env[name]?.trim() ?? "";
  if (!value) throw new GoogleIntegrationError(`Google integration is not configured: ${name} is required.`, 503, "not_configured");
  if (value.length > 4_000 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GoogleIntegrationError(`Google integration is not configured: ${name} is invalid.`, 503, "not_configured");
  }
  return value;
}

function configuredOAuth(env: Environment): GoogleOAuthConfig {
  const clientId = requiredEnvironment(env, "GOOGLE_CLIENT_ID");
  const clientSecret = requiredEnvironment(env, "GOOGLE_CLIENT_SECRET");
  const redirectUri = requiredEnvironment(env, "FROSH_GOOGLE_REDIRECT_URI");
  let callback: URL;
  try {
    callback = new URL(redirectUri);
  } catch {
    throw new GoogleIntegrationError("Google integration is not configured: FROSH_GOOGLE_REDIRECT_URI must be a URL.", 503, "not_configured");
  }
  const localhostHttp = callback.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname);
  if (
    !(callback.protocol === "https:" || localhostHttp) ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.search ||
    callback.pathname !== "/api/google/callback"
  ) {
    throw new GoogleIntegrationError(
      "Google integration is not configured: the redirect URI must be an HTTPS /api/google/callback URL (or localhost for development).",
      503,
      "not_configured",
    );
  }

  try {
    return { clientId, clientSecret, redirectUri: callback.toString(), encryptionKey: tokenEncryptionKeyFromEnvironment(env.FROSH_GOOGLE_TOKEN_ENCRYPTION_KEY) };
  } catch (error) {
    throw new GoogleIntegrationError(
      error instanceof Error ? error.message : "Google integration encryption is not configured.",
      503,
      "not_configured",
    );
  }
}

function publicConnection(connection: FroshStoredGoogleConnection | null): FroshGoogleConnection | null {
  if (!connection) return null;
  const { encryptedTokenSet: _, ...safe } = connection;
  return { ...safe, scopes: [...safe.scopes] };
}

function cleanToken(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || value.length > 8_000 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GoogleIntegrationError(`Google ${field} was invalid. Please reconnect your Google account.`, 409, "reconnect_required");
  }
  return value;
}

function parseStoredTokens(value: string): GoogleTokenSet {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(value) as Record<string, unknown>;
  } catch {
    throw new GoogleIntegrationError("Stored Google credentials are unreadable. Please reconnect your Google account.", 409, "reconnect_required");
  }
  const expiresAt = cleanToken(raw.expiresAt, "credential expiry");
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new GoogleIntegrationError("Stored Google credentials are invalid. Please reconnect your Google account.", 409, "reconnect_required");
  }
  return {
    accessToken: cleanToken(raw.accessToken, "access token"),
    refreshToken: cleanToken(raw.refreshToken, "refresh token"),
    expiresAt: new Date(expiresAt).toISOString(),
    tokenType: "Bearer",
  };
}

function compactText(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? cleaned.slice(0, maxChars) : undefined;
}

function validIso(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 100 || !Number.isFinite(Date.parse(value))) {
    throw new GoogleIntegrationError(`${label} must be a valid date-time.`, 400, "invalid_input");
  }
  return new Date(value).toISOString();
}

async function responseJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_REMOTE_JSON_BYTES) {
    throw new GoogleIntegrationError("Google returned an unexpectedly large response.", 502, "upstream_failed");
  }
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REMOTE_JSON_BYTES) {
    throw new GoogleIntegrationError("Google returned an unexpectedly large response.", 502, "upstream_failed");
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new GoogleIntegrationError("Google returned an invalid response.", 502, "upstream_failed");
  }
}

export class GoogleIntegrationService {
  constructor(
    private readonly store: FroshGoogleIntegrationStore,
    private readonly options: {
      environment?: Environment;
      fetcher?: FetchLike;
      now?: () => number;
    } = {},
  ) {}

  private get env(): Environment {
    return this.options.environment ?? process.env;
  }

  private get fetcher(): FetchLike {
    return this.options.fetcher ?? fetch;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private config(): GoogleOAuthConfig {
    return configuredOAuth(this.env);
  }

  isConfigured(): boolean {
    try {
      this.config();
      return true;
    } catch {
      return false;
    }
  }

  async connectionStatus(userId: string) {
    const configured = this.isConfigured();
    // Status should still be useful when a deployment is missing or has an
    // invalid Google secret. In that case there cannot be a usable connection,
    // and consulting the token store only makes a configuration issue harder to
    // diagnose.
    if (!configured) return { configured, connection: null };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const connection = await Promise.race([
        this.store.getConnection(userId),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new GoogleIntegrationError(
            "FROSH could not reach the secure Google connection store in time. Please retry shortly.",
            503,
            "upstream_failed",
          )), CONNECTION_STATUS_TIMEOUT_MS);
        }),
      ]);
      return { configured, connection: publicConnection(connection) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async beginAuthorization(userId: string): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const config = this.config();
    const state = randomOpaqueToken(32);
    const verifier = randomOpaqueToken(64);
    const expiresAt = new Date(this.now() + OAUTH_STATE_TTL_MS).toISOString();
    await this.store.createOAuthState({
      stateHash: await sha256Base64Url(state),
      userId,
      encryptedCodeVerifier: await encryptGoogleSecret(verifier, config.encryptionKey),
      expiresAt,
    });

    const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorization.searchParams.set("client_id", config.clientId);
    authorization.searchParams.set("redirect_uri", config.redirectUri);
    authorization.searchParams.set("response_type", "code");
    authorization.searchParams.set("scope", GOOGLE_REQUIRED_SCOPES.join(" "));
    authorization.searchParams.set("access_type", "offline");
    authorization.searchParams.set("include_granted_scopes", "true");
    authorization.searchParams.set("prompt", "consent");
    authorization.searchParams.set("state", state);
    authorization.searchParams.set("code_challenge", await sha256Base64Url(verifier));
    authorization.searchParams.set("code_challenge_method", "S256");
    return { authorizationUrl: authorization.toString(), expiresAt };
  }

  private async postToken(body: URLSearchParams): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await this.fetcher(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: body.toString(),
        signal: controller.signal,
      });
      const payload = await responseJson(response);
      if (!response.ok || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new GoogleIntegrationError("Google could not authorize this connection. Please try again.", 502, "authorization_failed");
      }
      return payload as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GoogleIntegrationError) throw error;
      throw new GoogleIntegrationError("Google could not be reached. Please try again.", 502, "upstream_failed");
    } finally {
      clearTimeout(timer);
    }
  }

  private tokenSetFromResponse(payload: Record<string, unknown>, currentRefreshToken?: string): GoogleTokenSet {
    const accessToken = cleanToken(payload.access_token, "access token");
    const refreshToken = typeof payload.refresh_token === "string" ? cleanToken(payload.refresh_token, "refresh token") : currentRefreshToken;
    if (!refreshToken) {
      throw new GoogleIntegrationError("Google did not return long-term access. Please reconnect and approve the requested access.", 502, "authorization_failed");
    }
    const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 7 * 24 * 60 * 60) {
      throw new GoogleIntegrationError("Google returned an invalid credential expiry. Please reconnect your account.", 502, "authorization_failed");
    }
    return {
      accessToken,
      refreshToken,
      expiresAt: new Date(this.now() + Math.floor(expiresIn) * 1_000).toISOString(),
      tokenType: "Bearer",
    };
  }

  private async encryptedTokens(connection: FroshStoredGoogleConnection, config: GoogleOAuthConfig): Promise<GoogleTokenSet> {
    try {
      return parseStoredTokens(await decryptGoogleSecret(connection.encryptedTokenSet, config.encryptionKey));
    } catch (error) {
      if (error instanceof GoogleIntegrationError) throw error;
      throw new GoogleIntegrationError("Stored Google credentials are unreadable. Please reconnect your Google account.", 409, "reconnect_required");
    }
  }

  async completeAuthorization(input: { code: string; state: string }): Promise<FroshGoogleConnection> {
    const code = typeof input.code === "string" ? input.code.trim() : "";
    const state = typeof input.state === "string" ? input.state.trim() : "";
    if (!code || code.length > 4_000 || !state || state.length > 1_000) {
      throw new GoogleIntegrationError("Google returned an incomplete authorization callback.", 400, "authorization_failed");
    }
    const config = this.config();
    const stateRecord = await this.store.consumeOAuthState(await sha256Base64Url(state));
    if (!stateRecord) {
      throw new GoogleIntegrationError("This Google connection link has expired or was already used. Start the connection again.", 400, "authorization_failed");
    }

    let verifier: string;
    try {
      verifier = await decryptGoogleSecret(stateRecord.encryptedCodeVerifier, config.encryptionKey);
    } catch {
      throw new GoogleIntegrationError("Google connection verification failed. Start the connection again.", 400, "authorization_failed");
    }

    const current = await this.store.getConnection(stateRecord.userId);
    const currentTokens = current ? await this.encryptedTokens(current, config).catch(() => null) : null;
    const response = await this.postToken(new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }));
    const tokens = this.tokenSetFromResponse(response, currentTokens?.refreshToken);
    const reportedScopes = typeof response.scope === "string"
      ? response.scope.split(/\s+/).filter((scope) => scope.length > 0 && scope.length <= 300)
      : [...GOOGLE_REQUIRED_SCOPES];
    if (reportedScopes.length && !GOOGLE_REQUIRED_SCOPES.every((scope) => reportedScopes.includes(scope))) {
      throw new GoogleIntegrationError("Google did not grant all required FROSH permissions. Please approve Calendar events and Gmail read-only access.", 400, "authorization_failed");
    }

    const now = new Date(this.now()).toISOString();
    const saved: FroshStoredGoogleConnection = {
      userId: stateRecord.userId,
      provider: "google",
      status: "connected",
      scopes: reportedScopes.length ? reportedScopes : [...GOOGLE_REQUIRED_SCOPES],
      encryptedTokenSet: await encryptGoogleSecret(JSON.stringify(tokens), config.encryptionKey),
      accessTokenExpiresAt: tokens.expiresAt,
      connectedAt: current?.connectedAt ?? now,
      updatedAt: now,
    };
    await this.store.saveConnection(saved);
    return publicConnection(saved)!;
  }

  private async refreshConnection(connection: FroshStoredGoogleConnection, config: GoogleOAuthConfig): Promise<GoogleTokenSet> {
    const existing = await this.encryptedTokens(connection, config);
    let payload: Record<string, unknown>;
    try {
      payload = await this.postToken(new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: existing.refreshToken,
        grant_type: "refresh_token",
      }));
    } catch (error) {
      await this.store.markReconnectRequired(connection.userId);
      if (error instanceof GoogleIntegrationError && error.code === "authorization_failed") {
        throw new GoogleIntegrationError("Google needs you to reconnect this account.", 409, "reconnect_required");
      }
      throw error;
    }
    const refreshed = this.tokenSetFromResponse(payload, existing.refreshToken);
    const updated: FroshStoredGoogleConnection = {
      ...connection,
      status: "connected",
      encryptedTokenSet: await encryptGoogleSecret(JSON.stringify(refreshed), config.encryptionKey),
      accessTokenExpiresAt: refreshed.expiresAt,
      updatedAt: new Date(this.now()).toISOString(),
    };
    await this.store.saveConnection(updated);
    return refreshed;
  }

  private async accessToken(userId: string, forceRefresh = false): Promise<string> {
    const config = this.config();
    const connection = await this.store.getConnection(userId);
    if (!connection) throw new GoogleIntegrationError("Connect Google before using Gmail or Calendar.", 409, "not_connected");
    if (connection.status === "reconnect_required") {
      throw new GoogleIntegrationError("Google needs you to reconnect this account.", 409, "reconnect_required");
    }
    const tokens = await this.encryptedTokens(connection, config);
    if (!forceRefresh && Date.parse(tokens.expiresAt) > this.now() + TOKEN_REFRESH_SKEW_MS) return tokens.accessToken;
    return (await this.refreshConnection(connection, config)).accessToken;
  }

  private async googleJson(userId: string, input: string | URL, init: RequestInit = {}): Promise<unknown> {
    const request = async (token: string) => {
      const headers = new Headers(init.headers);
      headers.set("accept", "application/json");
      headers.set("authorization", `Bearer ${token}`);
      return this.fetcher(input, { ...init, headers });
    };
    let response = await request(await this.accessToken(userId));
    if (response.status === 401) response = await request(await this.accessToken(userId, true));
    const payload = await responseJson(response);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new GoogleIntegrationError("Google denied this request. Reconnect FROSH or check the granted permissions.", 409, "reconnect_required");
      }
      throw new GoogleIntegrationError("Google could not complete this request. Please try again.", 502, "upstream_failed");
    }
    return payload;
  }

  async listUnreadGmail(userId: string, requestedLimit = 10): Promise<FroshGmailMessageSummary[]> {
    const limit = Math.max(1, Math.min(25, Math.trunc(requestedLimit) || 10));
    const listing = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listing.searchParams.set("maxResults", String(limit));
    listing.searchParams.append("labelIds", "INBOX");
    listing.searchParams.set("q", "is:unread");
    const result = await this.googleJson(userId, listing);
    const messages = result && typeof result === "object" && Array.isArray((result as { messages?: unknown }).messages)
      ? (result as { messages: unknown[] }).messages
      : [];
    const ids = messages.slice(0, limit).map((message) => message && typeof message === "object" ? (message as { id?: unknown }).id : undefined)
      .filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(id));

    return Promise.all(ids.map(async (id) => {
      const detail = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}`);
      detail.searchParams.set("format", "metadata");
      detail.searchParams.append("metadataHeaders", "From");
      detail.searchParams.append("metadataHeaders", "Subject");
      detail.searchParams.append("metadataHeaders", "Date");
      const raw = await this.googleJson(userId, detail);
      const item = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
      const headers = item.payload && typeof item.payload === "object" && Array.isArray((item.payload as { headers?: unknown }).headers)
        ? (item.payload as { headers: unknown[] }).headers : [];
      const header = (name: string) => headers.find((entry) => entry && typeof entry === "object" && String((entry as { name?: unknown }).name).toLowerCase() === name.toLowerCase()) as { value?: unknown } | undefined;
      const received = compactText(header("Date")?.value, 200);
      const receivedAt = received && Number.isFinite(Date.parse(received)) ? new Date(received).toISOString() : undefined;
      return {
        id,
        threadId: compactText(item.threadId, 200),
        from: compactText(header("From")?.value, 500),
        subject: compactText(header("Subject")?.value, 500) ?? "(no subject)",
        receivedAt,
        snippet: compactText(item.snippet, 800),
      };
    }));
  }

  async listCalendarEvents(userId: string, input: { from?: unknown; to?: unknown; limit?: unknown } = {}): Promise<FroshGoogleCalendarEvent[]> {
    const from = input.from === undefined ? new Date(this.now()).toISOString() : validIso(input.from, "from");
    const to = input.to === undefined ? new Date(this.now() + 7 * 24 * 60 * 60_000).toISOString() : validIso(input.to, "to");
    if (Date.parse(to) <= Date.parse(from) || Date.parse(to) - Date.parse(from) > 90 * 24 * 60 * 60_000) {
      throw new GoogleIntegrationError("Calendar dates must be ordered within a 90-day range.", 400, "invalid_input");
    }
    const requested = typeof input.limit === "number" ? input.limit : Number(input.limit ?? 20);
    const limit = Number.isInteger(requested) && requested >= 1 && requested <= 50 ? requested : 20;
    const endpoint = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
    endpoint.searchParams.set("timeMin", from);
    endpoint.searchParams.set("timeMax", to);
    endpoint.searchParams.set("singleEvents", "true");
    endpoint.searchParams.set("orderBy", "startTime");
    endpoint.searchParams.set("maxResults", String(limit));
    const raw = await this.googleJson(userId, endpoint);
    const items = raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? (raw as { items: unknown[] }).items : [];
    return items.slice(0, limit).flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const event = item as Record<string, unknown>;
      const id = compactText(event.id, 300);
      const start = event.start && typeof event.start === "object" ? event.start as Record<string, unknown> : {};
      const end = event.end && typeof event.end === "object" ? event.end as Record<string, unknown> : {};
      const startAt = typeof start.dateTime === "string" ? validCalendarDate(start.dateTime) : typeof start.date === "string" ? start.date + "T00:00:00.000Z" : undefined;
      const endAt = typeof end.dateTime === "string" ? validCalendarDate(end.dateTime) : typeof end.date === "string" ? end.date + "T00:00:00.000Z" : undefined;
      if (!id || !startAt || !endAt) return [];
      const htmlLink = compactText(event.htmlLink, 2_000);
      return [{
        id,
        summary: compactText(event.summary, 500) ?? "(untitled event)",
        description: compactText(event.description, 4_000),
        location: compactText(event.location, 500),
        startAt,
        endAt,
        ...(htmlLink?.startsWith("https://") ? { htmlLink } : {}),
      }];
    });
  }

  async createCalendarEvent(userId: string, input: Record<string, unknown>): Promise<FroshGoogleCalendarEvent> {
    const summary = compactText(input.summary, 500);
    if (!summary) throw new GoogleIntegrationError("Calendar event summary is required.", 400, "invalid_input");
    const startAt = validIso(input.startAt, "startAt");
    const endAt = validIso(input.endAt, "endAt");
    if (Date.parse(endAt) <= Date.parse(startAt) || Date.parse(endAt) - Date.parse(startAt) > 366 * 24 * 60 * 60_000) {
      throw new GoogleIntegrationError("Calendar event end must be after start and within one year.", 400, "invalid_input");
    }
    const description = compactText(input.description, 8_000);
    const location = compactText(input.location, 500);
    const payload = {
      summary,
      ...(description ? { description } : {}),
      ...(location ? { location } : {}),
      start: { dateTime: startAt },
      end: { dateTime: endAt },
    };
    const raw = await this.googleJson(userId, "https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const result = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const id = compactText(result.id, 300);
    const eventStart = result.start && typeof result.start === "object" ? result.start as Record<string, unknown> : {};
    const eventEnd = result.end && typeof result.end === "object" ? result.end as Record<string, unknown> : {};
    const savedStart = typeof eventStart.dateTime === "string" ? validCalendarDate(eventStart.dateTime) ?? startAt : startAt;
    const savedEnd = typeof eventEnd.dateTime === "string" ? validCalendarDate(eventEnd.dateTime) ?? endAt : endAt;
    if (!id) throw new GoogleIntegrationError("Google did not confirm the new calendar event.", 502, "upstream_failed");
    const htmlLink = compactText(result.htmlLink, 2_000);
    return {
      id,
      summary: compactText(result.summary, 500) ?? summary,
      description: compactText(result.description, 8_000) ?? description,
      location: compactText(result.location, 500) ?? location,
      startAt: savedStart,
      endAt: savedEnd,
      ...(htmlLink?.startsWith("https://") ? { htmlLink } : {}),
    };
  }

  async disconnect(userId: string): Promise<boolean> {
    const connection = await this.store.getConnection(userId);
    if (!connection) return false;
    try {
      const config = this.config();
      const tokens = await this.encryptedTokens(connection, config);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8_000);
      try {
        // Deleting locally is authoritative even when Google's revocation endpoint
        // is temporarily unavailable, so never let this request block disconnect.
        await this.fetcher(GOOGLE_REVOKE_URL, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: tokens.refreshToken }).toString(),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // The encrypted local credential is still erased below. Do not expose any
      // provider error or leave a user falsely connected because revocation failed.
    }
    return this.store.deleteConnection(userId);
  }
}

function validCalendarDate(value: string): string | undefined {
  return Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}
