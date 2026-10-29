"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import "./runs.css";
import { duration, evidenceLabel, summarise, when, type RunLike, type RunStatus, type ToolCall } from "./summary";

type Run = RunLike & {
  id: string;
  pendingApprovalId?: string;
  result?: string;
  error?: string;
};

type Counts = Record<RunStatus, number>;

type RunEvent = {
  id: string;
  type: string;
  status: RunStatus;
  message: string;
  createdAt: string;
};

type View = RunStatus | "all";

const POLL_MS = 8_000;

const TABS: Array<{ key: View; label: string }> = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "waiting_approval", label: "Waiting" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
  { key: "cancelled", label: "Stopped" },
];

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts>({ running: 0, waiting_approval: 0, completed: 0, failed: 0, cancelled: 0 });
  const [view, setView] = useState<View>("all");
  const [status, setStatus] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [eventsByRun, setEventsByRun] = useState<Record<string, RunEvent[]>>({});
  const [stopping, setStopping] = useState<string | null>(null);

  const load = useCallback(async (which: View) => {
    if (!userId) return;
    try {
      const response = await fetch("/api/frosh/v1/agent-runs/users/" + encodeURIComponent(userId) + "?status=" + which, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Request failed with status " + response.status);
      const body = await response.json();
      setRuns(Array.isArray(body.runs) ? body.runs : []);
      setCounts(body.counts ?? { running: 0, waiting_approval: 0, completed: 0, failed: 0, cancelled: 0 });
      setStatus("");
      setLoaded(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load runs");
      setLoaded(true);
    }
  }, [userId]);

  useEffect(() => {
    let active = true;
    void fetch("/api/frosh/v1/session", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not establish the FROSH account session.");
        const body = await response.json();
        if (typeof body?.userId !== "string" || !body.userId) throw new Error("FROSH returned an invalid account session.");
        if (active) setUserId(body.userId);
      })
      .catch((error: unknown) => {
        if (active) {
          setStatus(error instanceof Error ? error.message : "Could not establish the FROSH account session.");
          setLoaded(true);
        }
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!userId) return;
    void load(view);
    const timer = setInterval(() => void load(view), POLL_MS);
    return () => clearInterval(timer);
  }, [load, userId, view]);

  const total = counts.running + counts.waiting_approval + counts.completed + counts.failed + counts.cancelled;

  const toggleRunDetails = async (runId: string) => {
    if (!userId) return;
    if (expanded === runId) {
      setExpanded(null);
      return;
    }
    setExpanded(runId);
    if (eventsByRun[runId]) return;
    try {
      const response = await fetch(
        "/api/frosh/v1/agent-runs/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(runId) + "/events",
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error("Could not load run activity.");
      const body = await response.json();
      setEventsByRun((current) => ({ ...current, [runId]: Array.isArray(body.events) ? body.events : [] }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load run activity.");
    }
  };

  const stopRun = async (run: Run) => {
    if (!userId) return;
    setStopping(run.id);
    setStatus("");
    try {
      const response = await fetch(
        "/api/frosh/v1/agent-runs/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(run.id) + "/cancel",
        { method: "POST", cache: "no-store" },
      );
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Could not stop this run.");
      await load(view);
      setStatus("Run stopped. FROSH will not dispatch any more work for it.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not stop this run.");
    } finally {
      setStopping(null);
    }
  };

  return (
    <main className="runs-page">
      <header>
        <Link className="back" href="/">
          ← FROSH
        </Link>
        <div className="eyebrow">FROSH / RUNS</div>
        <h1>Coding runs</h1>
        <p>
          Every goal FROSH works toward, with the evidence behind it. A run is only
          complete when a validation command actually exited zero — that is what
          "Verified" means here, and nothing else does.
        </p>

        <div className="run-tabs">
          {TABS.map((tab) => {
            const count = tab.key === "all" ? total : counts[tab.key];
            return (
              <button
                key={tab.key}
                type="button"
                className={view === tab.key ? "active" : ""}
                onClick={() => setView(tab.key)}
              >
                {tab.label}
                <span>{count}</span>
              </button>
            );
          })}
        </div>
      </header>

      {status ? <div className="run-status">{status}</div> : null}

      {loaded && runs.length === 0 ? (
        <div className="run-empty">
          <strong>No runs yet.</strong>
          <span>
            Start one with <code>POST /v1/agent-runs</code> and <code>{'{"goal": "…", "mode": "loop"}'}</code>. It will
            appear here and stay visible while it works.
          </span>
        </div>
      ) : null}

      <div className="run-list">
        {runs.map((run) => {
          const evidence = summarise(run);
          const label = evidenceLabel(run);
          const open = expanded === run.id;
          return (
            <article key={run.id} className={"run-card " + run.status}>
              <div className="run-head">
                <div className="run-goal">{run.goal}</div>
                <span className={"run-state " + run.status}>{run.status.replace("_", " ")}</span>
              </div>

              <div className="run-meta">
                <span>{when(run.createdAt)}</span>
                {duration(run) ? <span>took {duration(run)}</span> : null}
                <span>{run.toolCalls.length} tool call{run.toolCalls.length === 1 ? "" : "s"}</span>
              </div>

              <div
                className={
                  "run-evidence " +
                  (label === "verified" ? "ok" : label === "none" ? "none" : "pending")
                }
              >
                {label === "verified" ? (
                  <>
                    <strong>Verified</strong> — <code>{evidence.lastCommand}</code> exited 0,{" "}
                    {evidence.edits} edit{evidence.edits === 1 ? "" : "s"} applied
                  </>
                ) : label === "failed_validation" ? (
                  <>
                    <strong>Not verified</strong> — <code>{evidence.lastCommand}</code> exited{" "}
                    {String(evidence.exitCode)}
                  </>
                ) : label === "unvalidated" ? (
                  <>
                    <strong>Not verified</strong> — {evidence.edits} edit{evidence.edits === 1 ? "" : "s"} applied and
                    nothing has validated them
                  </>
                ) : (
                  <>
                    <strong>No evidence</strong> — nothing has run yet
                  </>
                )}
              </div>

              {run.status === "waiting_approval" ? (
                <div className="run-waiting">
                  Waiting on a decision. <Link href="/approvals">Open the approval center →</Link>
                </div>
              ) : null}

              {run.status === "cancelled" ? (
                <div className="run-cancelled">Stopped by you. No later provider result can reopen this run.</div>
              ) : null}

              {run.status === "running" || run.status === "waiting_approval" ? (
                <div className="run-actions">
                  <button type="button" className="run-stop" disabled={stopping === run.id} onClick={() => void stopRun(run)}>
                    {stopping === run.id ? "Stopping…" : "Stop run"}
                  </button>
                </div>
              ) : null}

              {run.result ? <p className="run-result">{run.result}</p> : null}
              {run.error ? <p className="run-error">{run.error}</p> : null}

              <button className="run-toggle" type="button" onClick={() => void toggleRunDetails(run.id)}>
                {open
                  ? "Hide run activity"
                  : run.toolCalls.length > 0
                    ? "Show activity and " + run.toolCalls.length + " tool call" + (run.toolCalls.length === 1 ? "" : "s")
                    : "Show run activity"}
              </button>

              {open ? (
                <>
                  <ol className="run-events">
                    {(eventsByRun[run.id] ?? []).map((event) => (
                      <li key={event.id}>
                        <span className={"event-state " + event.status}>{event.status.replace("_", " ")}</span>
                        <span>{event.message}</span>
                        <time>{when(event.createdAt)}</time>
                      </li>
                    ))}
                    {eventsByRun[run.id]?.length === 0 ? <li>No activity record is available for this legacy run.</li> : null}
                  </ol>
                  {run.toolCalls.length > 0 ? (
                    <ol className="run-calls">
                      {run.toolCalls.map((call) => (
                        <li key={call.id}>
                          <span className={"call-name " + call.status}>{call.name}</span>
                          <span className="call-state">{call.status}</span>
                          <code className="call-args">{JSON.stringify(call.arguments)}</code>
                        </li>
                      ))}
                    </ol>
                  ) : null}
                </>
              ) : null}
            </article>
          );
        })}
      </div>
    </main>
  );
}
