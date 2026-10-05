"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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
