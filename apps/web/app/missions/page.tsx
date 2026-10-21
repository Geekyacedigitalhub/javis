"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import "./missions.css";

type MissionStatus = "planning" | "running" | "waiting_approval" | "completed" | "failed" | "paused" | "cancelled";
type MissionPriority = "low" | "normal" | "high";
type BudgetProfile = "standard" | "extended" | "intensive";

type MissionStep = {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "blocked" | "failed";
  result?: string;
  retryCount?: number;
};

type Mission = {
  id: string;
  userId: string;
  goal: string;
  status: MissionStatus;
  priority?: MissionPriority;
  budgetProfile?: BudgetProfile;
  progress: number;
  steps: MissionStep[];
  pendingApprovalId?: string;
  result?: string;
  toolCallsUsed?: number;
  executionDurationMs?: number;
  createdAt: string;
  updatedAt: string;
};

type MissionEvent = {
  id: string;
  type: string;
  message: string;
  stepId?: string;
  runId?: string;
  createdAt: string;
};

type Budgets = {
  maxSteps: number;
  maxToolCalls: number;
  maxDurationMs: number;
  profiles: Record<BudgetProfile, { maxSteps: number; maxToolCalls: number; maxDurationMs: number }>;
};

const userId = "default-user";
const ACTIVE: MissionStatus[] = ["planning", "running", "waiting_approval"];

function statusLabel(mission: Mission) {
  return mission.status.replace("_", " ");
}

function formatDuration(ms: number) {
  if (ms < 1000) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}

export default function MissionsPage() {
  const [items, setItems] = useState<Mission[]>([]);
  const [goal, setGoal] = useState("");
  const [priority, setPriority] = useState<MissionPriority>("normal");
  const [budgetProfile, setBudgetProfile] = useState<BudgetProfile>("standard");
  const [status, setStatus] = useState("");
  const [budgets, setBudgets] = useState<Budgets | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, MissionEvent[]>>({});
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const response = await fetch("/api/frosh/v1/missions/users/" + encodeURIComponent(userId), { cache: "no-store" });
      const data = await response.json();
      if (response.ok) setItems(data.missions ?? []);
      else setStatus(data.error ?? "Unable to load missions.");
    } catch {
      setStatus("Unable to reach the FROSH API.");
    }
  }

  async function loadEvents(missionId: string) {
    const response = await fetch(
      "/api/frosh/v1/missions/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(missionId) + "/events?limit=20",
      { cache: "no-store" },
    );
    if (!response.ok) return;
    const data = await response.json();
    setEvents((current) => ({ ...current, [missionId]: (data.events ?? []).slice().reverse() }));
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 8000);
    void fetch("/api/frosh/v1/missions/budgets", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setBudgets(data as Budgets));
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!expanded) return;
    void loadEvents(expanded);
    const source = new EventSource(
      "/api/frosh/v1/missions/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(expanded) + "/events/stream",
    );
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as MissionEvent & { type: string };
        if (event.type === "heartbeat") return;
        setEvents((current) => {
          const existing = current[expanded] ?? [];
          if (existing.some((item) => item.id === event.id)) return current;
          return { ...current, [expanded]: [event, ...existing].slice(0, 60) };
        });
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => source.close();
  }, [expanded]);

  async function create() {
    if (!goal.trim() || busy) return;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch("/api/frosh/v1/missions/users/" + encodeURIComponent(userId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ goal: goal.trim(), priority, budgetProfile }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not create mission.");
      setGoal("");
      setStatus("Mission created.");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not create mission.");
    } finally {
      setBusy(false);
    }
  }

  async function control(id: string, action: "run" | "continue" | "pause" | "resume" | "cancel") {
    if (action === "cancel" && !confirm("Cancel this mission?")) return;
    setStatus("Mission " + action + " requested…");
    const suffix = action === "run" || action === "continue" ? "" : "/" + action;
    const response = await fetch(
      "/api/frosh/v1/missions/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(id) + suffix,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
    );
    const data = await response.json().catch(() => ({}));
    setStatus(response.ok ? "Mission " + action + " accepted." : data.error ?? "Mission action failed.");
    await load();
  }

  async function remove(id: string) {
    if (!confirm("Delete this mission?")) return;
    const response = await fetch(
      "/api/frosh/v1/missions/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(id),
      { method: "DELETE" },
    );
    const data = await response.json().catch(() => ({}));
    setStatus(response.ok ? "Mission deleted." : data.error ?? "Delete failed.");
    if (expanded === id) setExpanded(null);
    await load();
  }

  const limits = budgets
    ? budgets.profiles[budgetProfile] ?? { maxSteps: budgets.maxSteps, maxToolCalls: budgets.maxToolCalls, maxDurationMs: budgets.maxDurationMs }
    : null;

  return (
    <main className="missions-page">
      <header>
        <Link href="/" className="back">
          ← FROSH Command Center
        </Link>
        <div className="eyebrow">FROSH / MISSIONS</div>
        <h1>Mission Control</h1>
        <p>Long-running objectives FROSH plans, executes, and verifies across steps.</p>

        <div className="mission-create">
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder="Describe the objective, e.g. Research MT5 backtesting libraries and summarise the top three."
          />
          <div className="mission-config" style={{ flexDirection: "column", alignItems: "stretch" }}>
            <label>
              Priority
              <select value={priority} onChange={(event) => setPriority(event.target.value as MissionPriority)}>
                <option value="low">Low</option>
                <option value="normal">Normal</option>
                <option value="high">High</option>
              </select>
            </label>
            <label>
              Budget
              <select value={budgetProfile} onChange={(event) => setBudgetProfile(event.target.value as BudgetProfile)}>
                <option value="standard">Standard</option>
                <option value="extended">Extended</option>
                <option value="intensive">Intensive</option>
              </select>
            </label>
            <button disabled={!goal.trim() || busy} onClick={() => void create()}>
              {busy ? "Creating…" : "Create mission"}
            </button>
          </div>
        </div>

        {limits && (
          <div className="mission-budget-card">
            <div>
              <strong>{budgetProfile} budget</strong>
              <span>
                {limits.maxSteps} steps · {limits.maxToolCalls} tool calls · {formatDuration(limits.maxDurationMs)}
              </span>
            </div>
          </div>
        )}
      </header>

      {status && <div className="mission-status">{status}</div>}

      <section className="mission-list">
        {items.map((mission) => {
          const usedSteps = mission.steps.length;
          const usedTools = mission.toolCallsUsed ?? 0;
          const usedMs = mission.executionDurationMs ?? 0;
          const isOpen = expanded === mission.id;
          return (
            <article className="mission-card" key={mission.id}>
              <div className="mission-head">
                <span>{new Date(mission.createdAt).toLocaleString()}</span>
                <span className={"mission-state " + mission.status}>{statusLabel(mission)}</span>
              </div>

              <h2>
                <Link href={"/missions/" + mission.id}>{mission.goal}</Link>
              </h2>

              <div className="progress">
                <i style={{ width: Math.round(Math.min(1, Math.max(0, mission.progress)) * 100) + "%" }} />
              </div>

              <div className="mission-budget-detail">
                <div className="budget-metric">
                  <strong>
                    {usedSteps} / {limits?.maxSteps ?? "—"} steps
                  </strong>
                  <span>plan progress</span>
                </div>
                <div className="budget-metric">
                  <strong>
                    {usedTools} / {limits?.maxToolCalls ?? "—"} tool calls
                  </strong>
                  <span>execution budget</span>
                </div>
                <div className="budget-metric">
                  <strong>{formatDuration(usedMs)}</strong>
                  <span>of {limits ? formatDuration(limits.maxDurationMs) : "—"}</span>
                </div>
              </div>

              {mission.steps.map((step) => (
                <div className={"mission-step " + (step.status === "running" ? "executing" : "")} key={step.id}>
                  <span className={step.status}>{step.status === "completed" ? "✓" : step.status === "failed" ? "✕" : step.status === "blocked" ? "!" : "•"}</span>
                  <div>
                    <strong>{step.title}</strong>
                    {step.retryCount ? <small>retries: {step.retryCount}</small> : null}
                    {step.result && <p>{step.result}</p>}
                  </div>
                </div>
              ))}

              {mission.pendingApprovalId && (
                <div className="approval-note">
                  Approval required before FROSH continues. Approve it in the run, then continue the mission.
                </div>
              )}

              {mission.result && <p className="mission-summary">{mission.result}</p>}

              <div className="mission-actions">
                {ACTIVE.includes(mission.status) && (
                  <button onClick={() => void control(mission.id, "run")}>Run next step</button>
                )}
                {mission.status === "waiting_approval" && (
                  <button onClick={() => void control(mission.id, "continue")}>Continue</button>
                )}
                {(mission.status === "running" || mission.status === "planning") && (
                  <button onClick={() => void control(mission.id, "pause")}>Pause</button>
                )}
                {mission.status === "paused" && (
                  <button onClick={() => void control(mission.id, "resume")}>Resume</button>
                )}
                <button onClick={() => setExpanded(isOpen ? null : mission.id)}>
                  {isOpen ? "Hide timeline" : "Timeline"}
                </button>
                <button onClick={() => void remove(mission.id)}>Delete</button>
              </div>

              {isOpen && (
                <div className="mission-timeline">
                  {(events[mission.id] ?? []).map((event) => (
                    <div className="timeline-event" key={event.id}>
                      <div className="timeline-marker">•</div>
                      <div className="timeline-event-body">
                        <strong>{event.type.replace(/\./g, " ")}</strong>
                        <p>{event.message}</p>
                        <time>{new Date(event.createdAt).toLocaleTimeString()}</time>
                      </div>
                    </div>
                  ))}
                  {!(events[mission.id] ?? []).length && <p>No events yet.</p>}
                </div>
              )}
            </article>
          );
        })}
        {!items.length && <div className="mission-empty">No missions yet. Create one above.</div>}
      </section>
    </main>
  );
}
