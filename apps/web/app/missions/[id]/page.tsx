"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import "../missions.css";

type MissionStatus = "planning" | "running" | "waiting_approval" | "completed" | "failed" | "paused" | "cancelled";
type MissionPriority = "low" | "normal" | "high";
type BudgetProfile = "standard" | "extended" | "intensive";

type MissionStep = {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "blocked" | "failed";
  result?: string;
  retryCount?: number;
  nextRetryAt?: string;
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
  activeRunId?: string;
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
  metadata?: Record<string, unknown>;
  createdAt: string;
};

const userId = "default-user";
const TERMINAL: MissionStatus[] = ["completed", "failed", "cancelled"];

function formatDuration(ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m " + (seconds % 60) + "s";
  return Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
}

function severityOf(type: string) {
  if (type.includes("failed") || type === "mission.failed") return "error";
  if (type.includes("approval")) return "approval";
  if (type.includes("budget") || type.includes("retry") || type.includes("paused")) return "warning";
  if (type.includes("completed") && !type.includes("tool")) return "success";
  if (type.includes("started") || type.includes("claimed") || type.includes("running")) return "active";
  return "info";
}

export default function MissionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [mission, setMission] = useState<Mission | null>(null);
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState(false);
  const [limit, setLimit] = useState(50);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");

  async function load() {
    try {
      const response = await fetch(
        "/api/frosh/v1/missions/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(id),
        { cache: "no-store" },
      );
      const data = await response.json();
      if (response.ok) setMission(data.mission);
      else setStatus(data.error ?? "Unable to load mission.");
    } catch {
      setStatus("Unable to reach the FROSH API.");
    }
  }

  async function loadEvents(nextLimit = limit) {
    const response = await fetch(
      "/api/frosh/v1/missions/users/" +
        encodeURIComponent(userId) +
        "/" +
        encodeURIComponent(id) +
        "/events?limit=" +
        nextLimit,
      { cache: "no-store" },
    );
    if (!response.ok) return;
    const data = await response.json();
    setEvents((data.events ?? []).slice().reverse());
  }

  useEffect(() => {
    void load();
    void loadEvents();
    const timer = setInterval(() => void load(), 6000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const source = new EventSource(
      "/api/frosh/v1/missions/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(id) + "/events/stream",
    );
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as MissionEvent & { type: string };
        if (event.type === "heartbeat") return;
        setEvents((current) => (current.some((item) => item.id === event.id) ? current : [event, ...current].slice(0, 400)));
        void load();
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function post(path: string, body?: unknown) {
    setBusy(true);
    try {
      const response = await fetch(
        "/api/frosh/v1/missions/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(id) + path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? {}),
        },
      );
      const data = await response.json().catch(() => ({}));
      setStatus(response.ok ? "Mission action accepted." : data.error ?? "Mission action failed.");
      if (data.mission) setMission(data.mission);
      await load();
      return response.ok;
    } catch {
      setStatus("Mission action failed.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this mission?")) return;
    const response = await fetch(
      "/api/frosh/v1/missions/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(id),
      { method: "DELETE" },
    );
    const data = await response.json().catch(() => ({}));
    setStatus(response.ok ? "Mission deleted." : data.error ?? "Delete failed.");
    if (response.ok) window.location.href = "/missions";
  }

  function exportTimeline() {
    const blob = new Blob([JSON.stringify({ mission, events }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "mission-" + id + "-timeline.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  const eventTypes = useMemo(() => {
    const set = new Set(events.map((event) => event.type));
    return ["all", ...Array.from(set).sort()];
  }, [events]);

  const visibleEvents = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return events.filter((event) => {
      if (filter !== "all" && event.type !== filter) return false;
      if (!needle) return true;
      return (event.message + " " + event.type).toLowerCase().includes(needle);
    });
  }, [events, filter, search]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const event of events) map.set(event.type, (map.get(event.type) ?? 0) + 1);
    return map;
  }, [events]);

  if (!mission) {
    return (
      <main className="missions-page">
        <Link href="/missions" className="back">
          ← Missions
        </Link>
        <div className="mission-status">{status || "Loading mission…"}</div>
      </main>
    );
  }

  const completedSteps = mission.steps.filter((step) => step.status === "completed").length;
  const failedSteps = mission.steps.filter((step) => step.status === "failed").length;
  const terminal = TERMINAL.includes(mission.status);

  return (
    <main className="missions-page mission-detail">
      <Link href="/missions" className="back">
        ← Missions
      </Link>

      <div className="mission-detail-header">
        <div>
          <div className="eyebrow">FROSH / MISSION</div>
          <h1>{mission.goal}</h1>
          <div className="mission-live-indicator">
            <span className="live-dot" style={{ opacity: live ? 1 : 0.25 }} />
            {live ? "Live timeline connected" : "Live timeline offline"}
          </div>
        </div>
        <span className="mission-state">{mission.status.replace("_", " ")}</span>
      </div>

      {status && <div className="mission-action-message">{status}</div>}

      <div className="mission-controls">
        {(mission.status === "planning" || mission.status === "running") && (
          <button disabled={busy} onClick={() => void post("")}>
            Run next step
          </button>
        )}
        {mission.status === "waiting_approval" && (
          <button disabled={busy} onClick={() => void post("/continue")}>
            Continue after approval
          </button>
        )}
        {(mission.status === "running" || mission.status === "planning") && (
          <button disabled={busy} onClick={() => void post("/pause")}>
            Pause
          </button>
        )}
        {mission.status === "paused" && (
          <button disabled={busy} onClick={() => void post("/resume")}>
            Resume
          </button>
        )}
        {!terminal && mission.status !== "waiting_approval" && (
          <button disabled={busy} onClick={() => void post("/recover")}>
            Recover
          </button>
        )}
        {terminal && (
          <button disabled={busy} onClick={() => void post("/rerun")}>
            Rerun mission
          </button>
        )}
        {!terminal && (
          <button disabled={busy} onClick={() => void post("/cancel")}>
            Cancel
          </button>
        )}
        <button disabled={busy} onClick={() => void remove()}>
          Delete
        </button>
      </div>

      <div className="mission-config">
        <label>
          Priority
          <select
            value={mission.priority ?? "normal"}
            disabled={busy}
            onChange={(event) => void post("/priority", { priority: event.target.value as MissionPriority })}
          >
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </select>
        </label>
        <label>
          Budget
          <select
            value={mission.budgetProfile ?? "standard"}
            disabled={busy}
            onChange={(event) => void post("/budget-profile", { budgetProfile: event.target.value as BudgetProfile })}
          >
            <option value="standard">Standard</option>
            <option value="extended">Extended</option>
            <option value="intensive">Intensive</option>
          </select>
        </label>
      </div>

      <div className="progress">
        <i style={{ width: Math.round(Math.min(1, Math.max(0, mission.progress)) * 100) + "%" }} />
      </div>

      <div className="mission-eta">
        <div>
          <strong>
            {completedSteps}/{mission.steps.length || 0} steps complete
          </strong>
          <span>
            {failedSteps} failed · {mission.toolCallsUsed ?? 0} tool calls · {formatDuration(mission.executionDurationMs ?? 0)}{" "}
            execution time
          </span>
        </div>
        <div>
          <strong>Created {new Date(mission.createdAt).toLocaleString()}</strong>
          <span>Updated {new Date(mission.updatedAt).toLocaleString()}</span>
        </div>
      </div>

      {mission.pendingApprovalId && (
        <div className="approval-note">
          FROSH is waiting for approval on run {mission.activeRunId ?? "pending"}. Approve the action, then continue the
          mission.
        </div>
      )}

      <section>
        <h2>Steps</h2>
        {mission.steps.map((step) => (
          <div className={"mission-step " + (step.status === "running" ? "executing" : "")} key={step.id}>
            <div className="mission-step-heading">
              <span className={step.status}>{step.status}</span>
              <strong>{step.title}</strong>
              {!terminal && mission.status !== "waiting_approval" && step.status !== "running" && (
                <button
                  className="mission-retry-button"
                  disabled={busy}
                  onClick={() => void post("/steps/" + encodeURIComponent(step.id) + "/retry")}
                >
                  Retry
                </button>
              )}
              {terminal && (
                <button
                  className="mission-retry-button"
                  disabled={busy}
                  onClick={() => void post("/rerun-from-step/" + encodeURIComponent(step.id))}
                >
                  Rerun from here
                </button>
              )}
            </div>
            {step.retryCount ? <small>retries: {step.retryCount}</small> : null}
            {step.result && <p>{step.result}</p>}
          </div>
        ))}
        {!mission.steps.length && <p>No steps planned yet.</p>}
      </section>

      {mission.result && (
        <section className="mission-summary">
          <h2>Result</h2>
          <p>{mission.result}</p>
        </section>
      )}

      <div className="timeline-heading">
        <h2>Timeline</h2>
        <button className="event-export" onClick={exportTimeline}>
          Export JSON
        </button>
      </div>

      <div className="timeline-legend">
        <span>
          <i className="legend-dot success" /> completed
        </span>
        <span>
          <i className="legend-dot active" /> running
        </span>
        <span>
          <i className="legend-dot warning" /> retry / budget
        </span>
        <span>
          <i className="legend-dot approval" /> approval
        </span>
        <span>
          <i className="legend-dot error" /> failed
        </span>
      </div>

      <div className="timeline-stats">
        <div>
          <strong>{events.length}</strong>
          <span>events</span>
        </div>
        <div>
          <strong>{counts.get("mission.step.completed") ?? 0}</strong>
          <span>steps done</span>
        </div>
        <div>
          <strong>{counts.get("mission.tool.completed") ?? 0}</strong>
          <span>tools run</span>
        </div>
        <div>
          <strong>{counts.get("mission.approval.required") ?? 0}</strong>
          <span>approvals</span>
        </div>
        <div>
          <strong>{counts.get("mission.failed") ?? 0}</strong>
          <span>failures</span>
        </div>
      </div>

      <input
        className="event-search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Search events…"
      />

      <div className="event-filters">
        {eventTypes.map((type) => (
          <button key={type} className={filter === type ? "active" : ""} onClick={() => setFilter(type)}>
            {type === "all" ? "All" : type.replace(/^mission\./, "").replace(/\./g, " ")}
          </button>
        ))}
      </div>

      <div className="mission-timeline">
        {visibleEvents.map((event) => {
          const severity = severityOf(event.type);
          return (
            <div className={"timeline-event severity-" + severity} key={event.id}>
              <div className={"timeline-marker severity-marker-" + severity}>
                {severity === "error" ? "✕" : severity === "success" ? "✓" : severity === "approval" ? "!" : "•"}
              </div>
              <div className="timeline-event-body">
                <strong>{event.type.replace(/^mission\./, "").replace(/\./g, " ")}</strong>
                <p>{event.message}</p>
                <time>{new Date(event.createdAt).toLocaleString()}</time>
                {event.metadata && Object.keys(event.metadata).length > 0 && (
                  <div className="timeline-event-details">
                    {Object.entries(event.metadata).map(([key, value]) => (
                      <span key={key}>
                        <b>{key}</b>
                        <code>{typeof value === "string" ? value : JSON.stringify(value)}</code>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {!visibleEvents.length && <p>No events match this filter.</p>}
      </div>

      <button
        className="event-load-more"
        onClick={() => {
          const next = limit + 50;
          setLimit(next);
          void loadEvents(next);
        }}
      >
        Load more events
      </button>
    </main>
  );
}
