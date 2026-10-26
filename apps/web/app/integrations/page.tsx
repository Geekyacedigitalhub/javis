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

function connectionMessage(): string {
  if (typeof window === "undefined") return "";
  const outcome = new URLSearchParams(window.location.search).get("google");
  if (outcome === "connected") return "Google connected. FROSH can now read unread Gmail metadata and calendar events; calendar changes still need your approval.";
  if (outcome === "cancelled") return "Google connection was cancelled. No access was granted.";
  if (outcome === "error") return "FROSH could not complete the Google connection. Start again, and make sure the callback URL and server secrets are configured.";
  return "";
}

export default function IntegrationsPage() {
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${API}/v1/integrations/google/users/${encodeURIComponent(USER_ID)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load Google connection status.");
      setGoogle(data);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load Google connection status.");
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
      const data = await response.json();
      if (!response.ok || typeof data.authorizationUrl !== "string") throw new Error(data.error ?? "Could not begin Google connection.");
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
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not disconnect Google.");
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
          <span className={connection && !reconnect ? "integration-pill connected" : reconnect ? "integration-pill warning" : "integration-pill"}>
            {connection && !reconnect ? "Connected" : reconnect ? "Reconnect needed" : google?.configured ? "Not connected" : "Setup needed"}
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

        {!google ? <p className="loading">Loading connection status…</p> : !google.configured ? (
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
