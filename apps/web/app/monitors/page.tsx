"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import "./monitors.css";

type Health = "unknown" | "healthy" | "degraded" | "down";
type Monitor = {
  id: string; name: string; url: string; intervalMinutes: number; status: "active" | "paused"; health: Health;
  nextCheckAt?: string; lastCheckedAt?: string; lastHealthyAt?: string; lastStatusCode?: number; lastLatencyMs?: number; lastError?: string;
};
type MonitorEvent = { id: string; type: string; health: Health; message: string; statusCode?: number; latencyMs?: number; createdAt: string };

const API = "/api/frosh";
const USER_ID = process.env.NEXT_PUBLIC_FROSH_USER_ID ?? "default-user";

function time(value?: string) { return value ? new Date(value).toLocaleString() : "Not checked yet"; }
function healthLabel(value: Health) { return value === "unknown" ? "Awaiting first check" : value; }

export default function MonitorsPage() {
  const [monitors, setMonitors] = useState<Monitor[]>([]);
  const [events, setEvents] = useState<Record<string, MonitorEvent[]>>({});
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [intervalMinutes, setIntervalMinutes] = useState("5");
  const [status, setStatus] = useState("Loading monitors…");
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const response = await fetch(`${API}/v1/monitors/users/${encodeURIComponent(USER_ID)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load monitors.");
      setMonitors(data.monitors ?? []);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not reach FROSH.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim() || !url.trim()) return;
    setBusy("create");
    try {
      const response = await fetch(`${API}/v1/monitors/users/${encodeURIComponent(USER_ID)}`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), url: url.trim(), intervalMinutes: Number(intervalMinutes) }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not create monitor.");
      setName(""); setUrl(""); setIntervalMinutes("5");
      setStatus("Monitor created. FROSH will check it now and then on its configured interval.");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create monitor.");
    } finally { setBusy(null); }
  }

  async function check(monitor: Monitor) {
    setBusy(`check:${monitor.id}`);
    try {
      const response = await fetch(`${API}/v1/monitors/users/${encodeURIComponent(USER_ID)}/${encodeURIComponent(monitor.id)}/check`, { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not check monitor.");
      setStatus(`${monitor.name} checked.`);
      await load();
      await loadEvents(monitor.id);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Monitor check failed."); }
    finally { setBusy(null); }
  }

  async function toggle(monitor: Monitor) {
    setBusy(`toggle:${monitor.id}`);
    try {
      const response = await fetch(`${API}/v1/monitors/users/${encodeURIComponent(USER_ID)}/${encodeURIComponent(monitor.id)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: monitor.status === "active" ? "paused" : "active" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not update monitor.");
      setStatus(`${monitor.name} is now ${data.monitor.status}.`);
      await load();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Monitor update failed."); }
    finally { setBusy(null); }
  }

  async function remove(monitor: Monitor) {
    if (!confirm(`Delete monitor “${monitor.name}”?`)) return;
    setBusy(`delete:${monitor.id}`);
    try {
      const response = await fetch(`${API}/v1/monitors/users/${encodeURIComponent(USER_ID)}/${encodeURIComponent(monitor.id)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not delete monitor.");
      setStatus(`${monitor.name} deleted.`); setEvents((current) => { const next = { ...current }; delete next[monitor.id]; return next; });
      await load();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Monitor deletion failed."); }
    finally { setBusy(null); }
  }

  async function loadEvents(monitorId: string) {
    setBusy(`events:${monitorId}`);
    try {
      const response = await fetch(`${API}/v1/monitors/users/${encodeURIComponent(USER_ID)}/${encodeURIComponent(monitorId)}/events`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load monitor history.");
      setEvents((current) => ({ ...current, [monitorId]: data.events ?? [] }));
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not load monitor history."); }
    finally { setBusy(null); }
  }

  return <main className="monitors-page">
    <header className="monitors-header">
      <div><Link href="/" className="back">← FROSH Command Center</Link><div className="eyebrow">FROSH / PROACTIVE OPERATIONS</div><h1>Service monitors</h1><p>FROSH securely checks public HTTPS endpoints and keeps a durable health history. Private-network targets are never allowed.</p></div>
      <button onClick={() => void load()} disabled={Boolean(busy)}>Refresh</button>
    </header>
    {status && <p className="monitor-status" role="status">{status}</p>}
    <form className="monitor-create" onSubmit={create}>
      <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Monitor name" maxLength={120} required />
      <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://service.example.com/health" type="url" maxLength={2000} required />
      <label>Every <select value={intervalMinutes} onChange={(event) => setIntervalMinutes(event.target.value)}><option value="5">5 min</option><option value="15">15 min</option><option value="30">30 min</option><option value="60">hour</option><option value="360">6 hours</option><option value="1440">day</option></select></label>
      <button disabled={busy === "create"}>{busy === "create" ? "Adding…" : "Add monitor"}</button>
    </form>
    <section className="monitor-list" aria-live="polite">
      {!monitors.length && <article className="empty"><h2>No monitors yet</h2><p>Add a public HTTPS endpoint to let FROSH watch it proactively.</p></article>}
      {monitors.map((monitor) => <article className="monitor-card" key={monitor.id}>
        <div className="monitor-title"><span className={`health ${monitor.health}`} aria-label={`Health: ${healthLabel(monitor.health)}`} /><div><h2>{monitor.name}</h2><a href={monitor.url} target="_blank" rel="noreferrer">{monitor.url}</a></div><span className={`state ${monitor.status}`}>{monitor.status}</span></div>
        <div className="monitor-facts"><span><b>{healthLabel(monitor.health)}</b> health</span><span><b>{monitor.lastStatusCode ?? "—"}</b> HTTP status</span><span><b>{monitor.lastLatencyMs === undefined ? "—" : `${monitor.lastLatencyMs} ms`}</b> latency</span><span>Checked {time(monitor.lastCheckedAt)}</span></div>
        {monitor.lastError && <p className="monitor-error">{monitor.lastError}</p>}
        <div className="monitor-actions"><button onClick={() => void check(monitor)} disabled={Boolean(busy) || monitor.status !== "active"}>{busy === `check:${monitor.id}` ? "Checking…" : "Check now"}</button><button onClick={() => void toggle(monitor)} disabled={Boolean(busy)}>{monitor.status === "active" ? "Pause" : "Resume"}</button><button onClick={() => void loadEvents(monitor.id)} disabled={Boolean(busy)}>{busy === `events:${monitor.id}` ? "Loading…" : "History"}</button><button className="danger" onClick={() => void remove(monitor)} disabled={Boolean(busy)}>Delete</button></div>
        {events[monitor.id] && <ol className="monitor-events">{!events[monitor.id].length && <li>No state transitions recorded yet.</li>}{events[monitor.id].map((entry) => <li key={entry.id}><span className={`event-dot ${entry.health}`} /> <b>{entry.type}</b> · {entry.message} <time>{time(entry.createdAt)}</time></li>)}</ol>}
      </article>)}
    </section>
  </main>;
}
