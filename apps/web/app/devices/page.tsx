"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import "./devices.css";

type Device = {
  id: string;
  name: string;
  platform: "android" | "windows" | "web";
  status: "online" | "offline" | "unknown";
  capabilities: string[];
  lastSeenAt?: string;
};

const API = "/api/frosh";

export default function DevicesPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [appNames, setAppNames] = useState<Record<string, string>>({});
  const [busyCommand, setBusyCommand] = useState<string | null>(null);
  const [inspectData, setInspectData] = useState<Record<string, unknown>>({});

  async function load() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`${API}/v1/devices`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load devices.");
      setDevices(data.devices ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not connect to FROSH.");
    } finally {
      setLoading(false);
    }
  }

  async function command(deviceId: string, command: string, extra: Record<string, string> = {}) {
    setBusyCommand(deviceId + ":" + command);
    setResult("");
    try {
      const response = await fetch(`${API}/v1/devices/${encodeURIComponent(deviceId)}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, ...extra })
      });
      const data = await response.json();
      setResult(data.message ?? (response.ok ? "Command completed." : "Command failed."));
    } catch {
      setResult("Could not send the device command.");
    } finally {
      setBusyCommand(null);
    }
  }

  async function inspect(deviceId: string, command: string, extra: Record<string, string> = {}) {
    setBusyCommand(deviceId + ":" + command);
    try {
      const response = await fetch(`${API}/v1/devices/${encodeURIComponent(deviceId)}/command`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, ...extra })
      });
      const data = await response.json();
      setResult(data.message ?? "Inspection complete.");
      if (data.data !== undefined) setInspectData((current) => ({ ...current, [deviceId + ":" + command]: data.data }));
    } catch {
      setResult("Device inspection failed.");
    } finally {
      setBusyCommand(null);
    }
  }

  async function openApp(device: Device) {
    const appName = (appNames[device.id] ?? "").trim();
    if (!appName) {
      setResult("Enter an Android app name first.");
      return;
    }
    await command(device.id, "open_app", { appName });
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <main className="device-page">
      <header className="device-header">
        <div>
          <Link href="/" className="back">← FROSH Command Center</Link>
          <div className="eyebrow">FROSH / DEVICES</div>
          <h1>Device Center</h1>
          <p>Connected computers and phones that FROSH can work with.</p>
        </div>
        <button className="refresh" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </button>
      </header>

      {error && <div className="device-error">{error}</div>}

      {result && <div className="device-result">{result}</div>}

      {!loading && !devices.length && (
        <section className="empty">
          <div className="empty-icon">◈</div>
          <h2>No devices connected</h2>
          <p>Pair the FROSH Android or Windows companion to make this device center active.</p>
        </section>
      )}

      <section className="device-grid">
        {devices.map((device) => (
          <article className="device-card" key={device.id}>
            <div className="device-top">
              <div className={`device-icon ${device.platform}`}>
                {device.platform === "android" ? "◆" : device.platform === "windows" ? "▦" : "◇"}
              </div>
              <span className={`device-status ${device.status}`}>
                <i /> {device.status}
              </span>
            </div>
            <h2>{device.name}</h2>
            <div className="platform">{device.platform.toUpperCase()}</div>
            <div className="capabilities">
              {device.capabilities.length
                ? device.capabilities.map((capability) => <span key={capability}>{capability}</span>)
                : <span className="muted">No capabilities reported</span>}
            </div>

            {device.platform === "android" && device.status === "online" && (
              <div className="device-controls">
                <div className="control-title">Quick controls</div>
                <div className="control-row">
                  <button disabled={!!busyCommand} onClick={() => void command(device.id, "open_dialer")}>Dialer</button>
                  <button disabled={!!busyCommand} onClick={() => void command(device.id, "media_control", { action: "toggle" })}>Play / Pause</button>
                  <button disabled={!!busyCommand} onClick={() => void command(device.id, "media_control", { action: "next" })}>Next</button>
                  <button disabled={!!busyCommand} onClick={() => void inspect(device.id, "media_state")}>Media State</button>
                  <button disabled={!!busyCommand} onClick={() => void inspect(device.id, "message_inbox")}>Messages</button>
                </div>
                <div className="inspect-row">
                  <input
                    placeholder="Search contacts"
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void inspect(device.id, "contacts_search", { query: event.currentTarget.value });
                    }}
                  />
                  <button disabled={!!busyCommand} onClick={(event) => {
                    const input = (event.currentTarget.parentElement?.querySelector("input") as HTMLInputElement | null);
                    if (input?.value.trim()) void inspect(device.id, "contacts_search", { query: input.value.trim() });
                  }}>Contacts</button>
                </div>
                {inspectData[device.id + ":media_state"] && (
                  <pre className="inspect-output">{JSON.stringify(inspectData[device.id + ":media_state"], null, 2)}</pre>
                )}
                {inspectData[device.id + ":message_inbox"] && (
                  <pre className="inspect-output">{JSON.stringify(inspectData[device.id + ":message_inbox"], null, 2)}</pre>
                )}
                {inspectData[device.id + ":contacts_search"] && (
                  <pre className="inspect-output">{JSON.stringify(inspectData[device.id + ":contacts_search"], null, 2)}</pre>
                )}
                <div className="app-control">
                  <input
                    value={appNames[device.id] ?? ""}
                    onChange={(event) => setAppNames((current) => ({ ...current, [device.id]: event.target.value }))}
                    placeholder="App name, e.g. Spotify"
                  />
                  <button disabled={!!busyCommand} onClick={() => void openApp(device)}>
                    {busyCommand === device.id + ":open_app" ? "Opening…" : "Open"}
                  </button>
                </div>
              </div>
            )}

            <footer>
              {device.lastSeenAt
                ? `Last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                : "No heartbeat yet"}
            </footer>
          </article>
        ))}
      </section>
    </main>
  );
}
