export type FroshGoogleConnectionStatus = "connected" | "reconnect_required";

/**
 * Metadata that is safe to return to an authenticated FROSH client. OAuth
 * access and refresh tokens deliberately never appear in this contract.
 */
export interface FroshGoogleConnection {
  userId: string;
  provider: "google";
  status: FroshGoogleConnectionStatus;
  scopes: string[];
  accessTokenExpiresAt: string;
  connectedAt: string;
  updatedAt: string;
}

/** Internal encrypted record, used only by the Google integration service. */
export interface FroshStoredGoogleConnection extends FroshGoogleConnection {
  encryptedTokenSet: string;
}

/** One-time, PKCE-bound authorization state. Never expose the verifier. */
export interface FroshGoogleOAuthState {
  stateHash: string;
  userId: string;
  encryptedCodeVerifier: string;
  expiresAt: string;
}

export interface FroshGoogleIntegrationStore {
  getConnection(userId: string): Promise<FroshStoredGoogleConnection | null>;
  saveConnection(connection: FroshStoredGoogleConnection): Promise<void>;
  markReconnectRequired(userId: string): Promise<void>;
  deleteConnection(userId: string): Promise<boolean>;
  createOAuthState(state: FroshGoogleOAuthState): Promise<void>;
  /** Atomically consumes a state so an OAuth callback cannot be replayed. */
  consumeOAuthState(stateHash: string): Promise<FroshGoogleOAuthState | null>;
}

export interface FroshGoogleCalendarEvent {
  id: string;
  summary: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  htmlLink?: string;
}

export interface FroshGmailMessageSummary {
  id: string;
  threadId?: string;
  from?: string;
  subject?: string;
  receivedAt?: string;
  snippet?: string;
}
