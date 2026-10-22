"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import "./approvals.css";

type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

type Approval = {
  id: string;
  runId?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
};

type Counts = Record<ApprovalStatus, number>;

const userId = "default-user";
const POLL_MS = 10_000;

function remainingLabel(approval: Approval): string {
  if (approval.status !== "pending") {
    const when = approval.resolvedAt ? new Date(approval.resolvedAt).toLocaleString() : "";
    return approval.status + (when ? " · " + when : "");
  }
  const left = Date.parse(approval.expiresAt) - Date.now();
  if (left <= 0) return "expired";
  const seconds = Math.floor(left / 1000);
  const minutes = Math.floor(seconds / 60);
  return "expires in " + minutes + ":" + String(seconds % 60).padStart(2, "0");
}

function describeArguments(args: Record<string, unknown>): string {
  try {
    const text = JSON.stringify(args, null, 2);
    return text.length > 1200 ? text.slice(0, 1200) + "\n…" : text;
  } catch {
    return "(unreadable arguments)";
  }
}

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [counts, setCounts] = useState<Counts>({ pending: 0, approved: 0, rejected: 0, expired: 0 });
  const [view, setView] = useState<"pending" | "all">("pending");
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (which: "pending" | "all") => {
    try {
      const response = await fetch(
        "/api/frosh/v1/approvals/users/" + encodeURIComponent(userId) + "?status=" + which,
        { cache: "no-store" },
      );
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        setApprovals(data.approvals ?? []);
        if (data.counts) setCounts(data.counts);
      } else {
        setStatus(data.error ?? "Unable to load approvals.");
      }
    } catch {
      setStatus("Unable to reach the FROSH API.");
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load(view);
  }, [load, view]);

  // Pending approvals expire on their own, so keep the list honest while it is open.
  useEffect(() => {
    if (view !== "pending") return;
    const timer = setInterval(() => void load("pending"), POLL_MS);
    return () => clearInterval(timer);
  }, [load, view]);

  async function decide(id: string, action: "approve" | "reject") {
    if (action === "reject" && !confirm("Reject this action? FROSH will not perform it.")) return;
    setBusy(id);
    setStatus(action === "approve" ? "Approving…" : "Rejecting…");
    try {
      const response = await fetch(
        "/api/frosh/v1/approvals/users/" + encodeURIComponent(userId) + "/" + encodeURIComponent(id) + "/" + action,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) },
      );
      const data = await response.json().catch(() => ({}));
      setStatus(
        response.ok
          ? "Approval " + (action === "approve" ? "granted" : "rejected") + "."
          : data.error ?? "Approval action failed.",
      );
    } catch {
      setStatus("Unable to reach the FROSH API.");
    } finally {
      setBusy(null);
      await load(view);
    }
  }

  return (
    <main className="approvals-page">
      <header>
        <Link href="/" className="back">
          ← FROSH Command Center
        </Link>
        <div className="eyebrow">FROSH / APPROVALS</div>
        <h1>Approval Center</h1>
        <p>
          Actions FROSH considers consequential wait here. Nothing runs until you allow it, and every
          decision is kept in the history below.
        </p>

        <div className="approval-tabs">
          <button className={view === "pending" ? "active" : ""} onClick={() => setView("pending")}>
            Pending <span>{counts.pending}</span>
          </button>
          <button className={view === "all" ? "active" : ""} onClick={() => setView("all")}>
            History <span>{counts.approved + counts.rejected + counts.expired}</span>
          </button>
        </div>
      </header>

      {status && <div className="approval-status">{status}</div>}

      <section className="approval-list">
        {approvals.map((approval) => (
          <article className={"approval-card " + approval.status} key={approval.id}>
            <div className="approval-head">
              <span className="approval-tool">{approval.toolName}</span>
              <span className={"approval-state " + approval.status}>{approval.status}</span>
            </div>

            <p className="approval-reason">{approval.reason}</p>

            <pre className="approval-args">{describeArguments(approval.arguments)}</pre>

            <div className="approval-meta">
              <span>{remainingLabel(approval)}</span>
              <span>requested {new Date(approval.createdAt).toLocaleTimeString()}</span>
              {approval.runId && <span className="approval-run">run {approval.runId.slice(0, 8)}</span>}
            </div>

            {approval.status === "pending" && (
              <div className="approval-actions">
                <button
                  className="approve"
                  disabled={busy === approval.id}
                  onClick={() => void decide(approval.id, "approve")}
                >
                  {busy === approval.id ? "Working…" : "Approve and run"}
                </button>
                <button onClick={() => void decide(approval.id, "reject")} disabled={busy === approval.id}>
                  Reject
                </button>
              </div>
            )}
          </article>
        ))}

        {!approvals.length && loaded && (
          <div className="approval-empty">
            {view === "pending"
              ? "Nothing is waiting for you. Actions that need approval will appear here."
              : "No approvals have been requested yet."}
          </div>
        )}
      </section>
    </main>
  );
}
