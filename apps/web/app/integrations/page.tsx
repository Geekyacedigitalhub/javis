"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import "./integrations.css";

type GoogleConnection = {
  provider: "google";
  status: "connected" | "reconnect_required";
  scopes: string[];
  accessTokenExpiresAt: string;
  connectedAt: string;
  updatedAt: string;
};

type GoogleStatus = {
  configured: boolean;
  connection: GoogleConnection | null;
};

const API = "/api/frosh";
const USER_ID = process.env.NEXT_PUBLIC_FROSH_USER_ID ?? "default-user";
const GOOGLE_STATUS_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 15_000] as const;

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function connectionMessage(): string {
  if (typeof window === "undefined") return "";
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get("google");
  if (outcome === "connected") return "Google connected. FROSH can now read unread Gmail metadata and calendar events; calendar changes still need your approval.";
  if (outcome === "cancelled") return "Google connection was cancelled. No access was granted.";
  if (outcome === "error") {
    const message = (params.get("google_message") ?? "")
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    if (message) return `FROSH could not complete the Google connection: ${message}`;
    const code = params.get("google_code");
    if (code === "upstream_failed") return "FROSH could not reach Google to complete the connection. Please retry shortly.";
    if (code === "not_configured") return "FROSH Google configuration is incomplete. Check the server-only Google settings.";
    return "FROSH could not complete the Google connection. Start again, and make sure the callback URL and server secrets are configured.";
  }
  return "";
}

async function apiPayload(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {
      error: response.ok
        ? "FROSH returned an unexpected response. Please retry shortly."
        : `FROSH service returned ${response.status}. Please retry shortly.`,
    };
  }
}

export default function IntegrationsPage() {
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      for (let attempt = 0; ; attempt += 1) {
        // Network exceptions are retryable; a valid non-5xx API response is
        // not. Keep that distinction when deciding whether to wait again.
        let retryable = true;
        try {
          const response = await fetch(`${API}/v1/integrations/google/users/${encodeURIComponent(USER_ID)}`, { cache: "no-store" });
          const data = await apiPayload(response);
          if (response.ok) {
            if (typeof data.configured !== "boolean" || !("connection" in data)) {
              retryable = false;
              throw new Error("FROSH returned an invalid Google connection status. Please retry shortly.");
            }
            setGoogle(data as GoogleStatus);
            setStatus("");
            return;
          }

          const message = typeof data.error === "string" ? data.error : "Could not load Google connection status.";
          // A missing Google setup is a useful, final response. Only retry
          // transient gateway/API failures while Render wakes a free instance.
          retryable = response.status >= 500 && data.code !== "not_configured";
          throw new Error(message);
        } catch (error) {
          if (!retryable || attempt === GOOGLE_STATUS_RETRY_DELAYS_MS.length) throw error;
        }

        const delay = GOOGLE_STATUS_RETRY_DELAYS_MS[attempt];
        setStatus(`Waking FROSH API — retrying in ${Math.ceil(delay / 1000)} seconds…`);
        await wait(delay);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load Google connection status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setStatus(connectionMessage());
    void load();
  }, [load]);

  async function connect() {
    if (busy) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`${API}/v1/integrations/google/users/${encodeURIComponent(USER_ID)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const data = await apiPayload(response);
      if (!response.ok || typeof data.authorizationUrl !== "string") {
        throw new Error(typeof data.error === "string" ? data.error : "Could not begin Google connection.");
      }
      window.location.assign(data.authorizationUrl);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not begin Google connection.");
      setBusy(false);
    }
  }

  async function disconnect() {
    if (busy || !confirm("Disconnect Google? FROSH will erase its encrypted local credential and stop accessing Gmail and Calendar.")) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(`${API}/v1/integrations/google/users/${encodeURIComponent(USER_ID)}`, { method: "DELETE" });
      const data = await apiPayload(response);
      if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not disconnect Google.");
      setStatus(data.disconnected ? "Google disconnected. FROSH no longer has a stored Google credential." : "Google was already disconnected.");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not disconnect Google.");
    } finally {
      setBusy(false);
    }
  }

  const connection = google?.connection;
  const reconnect = connection?.status === "reconnect_required";
  const unavailable = !loading && !google && Boolean(status);

  return (
    <main className="integrations-page">
      <header>
        <Link href="/" className="back">← FROSH Command Center</Link>
        <div className="eyebrow">FROSH / INTEGRATIONS</div>
        <h1>Your connected services</h1>
        <p>Connections are tied to your FROSH account. OAuth tokens are encrypted on the server and are never shown in this console.</p>
      </header>

      {status && <div className="integration-status" role="status">{status}</div>}

      <section className="integration-card">
        <div className="integration-card-head">
          <div className="google-mark" aria-hidden="true">G</div>
          <div>
            <h2>Google</h2>
            <p>Gmail and Google Calendar</p>
          </div>
          <span className={connection && !reconnect ? "integration-pill connected" : reconnect || unavailable ? "integration-pill warning" : "integration-pill"}>
            {connection && !reconnect
              ? "Connected"
              : reconnect
                ? "Reconnect needed"
                : loading
                  ? "Checking…"
                  : unavailable
                    ? "Unavailable"
                    : google?.configured
                      ? "Not connected"
                      : "Setup needed"}
          </span>
        </div>

        <div className="integration-details">
          <div><strong>Gmail</strong><span>Read unread message metadata for summaries. FROSH cannot send, delete, or modify mail.</span></div>
          <div><strong>Calendar</strong><span>Read events. Creating or changing an event always goes through Approval Center.</span></div>
          <div><strong>Privacy</strong><span>OAuth tokens are AES-GCM encrypted server-side. Disconnecting removes the stored credential.</span></div>
        </div>

        {connection && (
          <div className="connection-meta">
            <span>Connected {new Date(connection.connectedAt).toLocaleString()}</span>
            <span>Granted {connection.scopes.length} permission{connection.scopes.length === 1 ? "" : "s"}</span>
          </div>
        )}

        {!google ? (
          <p className="loading">{loading ? "Checking connection status…" : "Connection status is unavailable. Retry shortly."}</p>
        ) : !google.configured ? (
          <p className="setup-note">Add the Google client ID, client secret, callback URL, and token-encryption key to your deployment’s secret manager before connecting.</p>
        ) : connection && !reconnect ? (
          <button className="disconnect" disabled={busy} onClick={() => void disconnect()}>{busy ? "Disconnecting…" : "Disconnect Google"}</button>
        ) : (
          <button className="connect" disabled={busy} onClick={() => void connect()}>{busy ? "Opening Google…" : reconnect ? "Reconnect Google" : "Connect Google"}</button>
        )}
      </section>

      <section className="integration-safety">
        <h2>How FROSH uses this connection</h2>
        <ul>
          <li>Read actions are limited to the Gmail and Calendar permissions you approved.</li>
          <li>Calendar writes are consequential actions and require a separate, explicit approval.</li>
          <li>FROSH does not request Gmail sending access unless you deliberately enable it later.</li>
          <li>While Google OAuth is in Testing, Google may ask you to reconnect periodically.</li>
        </ul>
      </section>
    </main>
  );
}
