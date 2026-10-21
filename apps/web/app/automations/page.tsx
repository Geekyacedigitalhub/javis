"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import "./automations.css";

type AutomationSchedule =
  | { type: "once"; runAt: string }
  | { type: "daily"; hour: number; minute: number }
  | { type: "weekly"; dayOfWeek: number; hour: number; minute: number }
  | { type: "interval"; minutes: number };

type ScheduleType = AutomationSchedule["type"];

type Automation = {
  id: string;
  userId: string;
  name: string;
  prompt: string;
  schedule: AutomationSchedule;
  status: "active" | "paused" | "completed";
  nextRunAt?: string;
  lastRunAt?: string;
};

const userId = "default-user";
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hhmm(hour: number, minute: number) {
  return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}

function describeSchedule(schedule: AutomationSchedule): string {
  switch (schedule.type) {
    case "once":
      return "Once at " + new Date(schedule.runAt).toLocaleString();
    case "daily":
      return "Daily at " + hhmm(schedule.hour, schedule.minute);
    case "weekly":
      return DAYS[schedule.dayOfWeek] + " at " + hhmm(schedule.hour, schedule.minute);
    case "interval":
      return "Every " + schedule.minutes + " minutes";
  }
}

export default function AutomationsPage() {
  const [items, setItems] = useState<Automation[]>([]);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [type, setType] = useState<ScheduleType>("once");
  const [runAt, setRunAt] = useState("");
  const [hour, setHour] = useState("9");
  const [minute, setMinute] = useState("0");
  const [dayOfWeek, setDayOfWeek] = useState("1");
  const [interval, setIntervalMinutes] = useState("60");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  async function load() {
    try {
      const response = await fetch("/api/frosh/v1/automations/users/" + encodeURIComponent(userId), { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setItems(data.automations ?? []);
      else setStatus(data.error ?? "Unable to load automations.");
    } catch {
      setStatus("Unable to reach the FROSH API.");
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 15000);
    return () => clearInterval(timer);
  }, []);

  function buildSchedule(): AutomationSchedule | null {
    if (type === "once") {
      if (!runAt) return null;
      return { type, runAt: new Date(runAt).toISOString() };
    }
    if (type === "interval") return { type, minutes: Number(interval) };
    if (type === "weekly") {
      return { type, dayOfWeek: Number(dayOfWeek), hour: Number(hour), minute: Number(minute) };
    }
    return { type: "daily", hour: Number(hour), minute: Number(minute) };
  }

  const scheduleReady = type !== "once" || Boolean(runAt) && !Number.isNaN(new Date(runAt).getTime());
  const canCreate = Boolean(name.trim() && prompt.trim() && scheduleReady) && !busy;

  async function create() {
    const schedule = buildSchedule();
    if (!schedule) {
      setStatus("Choose a valid run time.");
      return;
    }
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/frosh/v1/automations/users/" + encodeURIComponent(userId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim(), prompt: prompt.trim(), schedule }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Creation failed");
      setName("");
      setPrompt("");
      setStatus("Automation created.");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Creation failed");
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: Automation) {
    const next = item.status === "active" ? "paused" : "active";
    const response = await fetch(
      "/api/frosh/v1/automations/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(item.id),
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: next }),
      },
    );
    const data = await response.json();
    setStatus(data.automation ? "Automation " + next + "." : data.error ?? "Update failed.");
    await load();
  }

  async function remove(item: Automation) {
    if (!confirm("Delete " + item.name + "?")) return;
    const response = await fetch(
      "/api/frosh/v1/automations/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(item.id),
      { method: "DELETE" },
    );
    setStatus(response.ok ? "Automation deleted." : "Delete failed.");
    await load();
  }

  return (
    <main className="automation-page">
      <header className="automation-header">
        <div>
          <Link href="/" className="back">
            ← FROSH Command Center
          </Link>
          <div className="eyebrow">FROSH / AUTOMATIONS</div>
          <h1>Automation Center</h1>
          <p>Schedule recurring work, reminders, and future FROSH actions.</p>
        </div>
      </header>

      {status && <div className="automation-status">{status}</div>}

      <section className="automation-builder">
        <div className="eyebrow">NEW AUTOMATION</div>
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, e.g. Morning brief" />
        <textarea
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="What should FROSH do when this runs?"
        />
        <div className="schedule-row">
          <select value={type} onChange={(event) => setType(event.target.value as ScheduleType)}>
            <option value="once">One time</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="interval">Every interval</option>
          </select>

          {type === "once" && (
            <input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} />
          )}

          {type === "interval" && (
            <input
              type="number"
              min="60"
              value={interval}
              onChange={(event) => setIntervalMinutes(event.target.value)}
            />
          )}

          {type === "weekly" && (
            <select value={dayOfWeek} onChange={(event) => setDayOfWeek(event.target.value)}>
              {DAYS.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </select>
          )}

          {(type === "daily" || type === "weekly") && (
            <>
              <input type="number" min="0" max="23" value={hour} onChange={(event) => setHour(event.target.value)} />
              <input
                type="number"
                min="0"
                max="59"
                value={minute}
                onChange={(event) => setMinute(event.target.value)}
              />
            </>
          )}
        </div>
        <button className="create" disabled={!canCreate} onClick={() => void create()}>
          {busy ? "Creating…" : "Create automation"}
        </button>
      </section>

      <section className="automation-list">
        {items.map((item) => (
          <article className="automation-card" key={item.id}>
            <div>
              <h2>{item.name}</h2>
              <p>{item.prompt}</p>
            </div>
            <span className={"automation-state " + item.status}>{item.status}</span>
            <div className="automation-meta">{describeSchedule(item.schedule)}</div>
            <div className="automation-meta">
              {item.nextRunAt ? "Next: " + new Date(item.nextRunAt).toLocaleString() : "No next run"}
            </div>
            <div className="automation-actions">
              <button onClick={() => void toggle(item)} disabled={item.status === "completed"}>
                {item.status === "active" ? "Pause" : "Resume"}
              </button>
              <button onClick={() => void remove(item)}>Delete</button>
            </div>
          </article>
        ))}
        {!items.length && <div className="automation-empty">No automations yet.</div>}
      </section>
    </main>
  );
}
