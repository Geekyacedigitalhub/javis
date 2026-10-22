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

type View = RunStatus | "all";

const userId = "default-user";
const POLL_MS = 8_000;

const TABS: Array<{ key: View; label: string }> = [
  { key: "all", label: "All" },
  { key: "running", label: "Running" },
  { key: "waiting_approval", label: "Waiting" },
  { key: "completed", label: "Completed" },
  { key: "failed", label: "Failed" },
];

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [counts, setCounts] = useState<Counts>({ running: 0, waiting_approval: 0, completed: 0, failed: 0 });
  const [view, setView] = useState<View>("all");
  const [status, setStatus] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (which: View) => {
    try {
      const response = await fetch("/api/frosh/v1/agent-runs/users/" + encodeURIComponent(userId) + "?status=" + which, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Request failed with status " + response.status);
      const body = await response.json();
      setRuns(Array.isArray(body.runs) ? body.runs : []);
      setCounts(body.counts ?? { running: 0, waiting_approval: 0, completed: 0, failed: 0 });
      setStatus("");
      setLoaded(true);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not load runs");
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load(view);
    const timer = setInterval(() => void load(view), POLL_MS);
    return () => clearInterval(timer);
  }, [load, view]);

  const total = counts.running + counts.waiting_approval + counts.completed + counts.failed;

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

              {run.result ? <p className="run-result">{run.result}</p> : null}
              {run.error ? <p className="run-error">{run.error}</p> : null}

              {run.toolCalls.length > 0 ? (
                <button className="run-toggle" type="button" onClick={() => setExpanded(open ? null : run.id)}>
                  {open ? "Hide tool calls" : "Show " + run.toolCalls.length + " tool call" + (run.toolCalls.length === 1 ? "" : "s")}
                </button>
              ) : null}

              {open ? (
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
            </article>
          );
        })}
      </div>
    </main>
  );
}
