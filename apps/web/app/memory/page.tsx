"use client";

import { useEffect, useState } from "react";

type Memory = {
  id: string;
  kind: string;
  statement: string;
  confidence: number;
  updatedAt: string;
};

type Candidate = Memory & {
  status: "pending" | "approved" | "rejected";
  createdAt: string;
};

const API = process.env.NEXT_PUBLIC_FROSH_API_URL ?? "http://localhost:3001";
const USER_ID = process.env.NEXT_PUBLIC_FROSH_USER_ID ?? "default-user";

export default function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  async function load() {
    setLoading(true);
    try {
      const [memoryResponse, candidateResponse] = await Promise.all([
        fetch(`${API}/v1/memory/users/${encodeURIComponent(USER_ID)}`),
        fetch(`${API}/v1/memory/users/${encodeURIComponent(USER_ID)}/candidates`)
      ]);
      const memoryData = await memoryResponse.json();
      const candidateData = await candidateResponse.json();
      setMemories(memoryData.memories ?? []);
      setCandidates(candidateData.candidates ?? []);
    } catch {
      setMessage("Could not connect to the FROSH API.");
    } finally {
      setLoading(false);
    }
  }

  async function resolveCandidate(candidateId: string, status: "approved" | "rejected") {
    setMessage("");
    const response = await fetch(
      `${API}/v1/memory/users/${encodeURIComponent(USER_ID)}/candidates`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId, status }) }
    );
    if (!response.ok) {
      setMessage("Memory update failed.");
      return;
    }
    setMessage(status === "approved" ? "Memory saved." : "Memory rejected.");
    await load();
  }

  async function forget(memoryId: string) {
    if (!window.confirm("Forget this memory?")) return;
    const response = await fetch(
      `${API}/v1/memory/users/${encodeURIComponent(USER_ID)}/${encodeURIComponent(memoryId)}`,
      { method: "DELETE" }
    );
    if (!response.ok) {
      setMessage("Could not delete memory.");
      return;
    }
    setMessage("Memory forgotten.");
    await load();
  }

  useEffect(() => { void load(); }, []);

  return (
    <main style={{ minHeight: "100vh", padding: "36px 22px", maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ marginBottom: 32 }}>
        <div style={{ color: "#34d399", fontWeight: 800, letterSpacing: "0.14em" }}>FROSH / MEMORY</div>
        <h1 style={{ fontSize: 42, margin: "12px 0 8px" }}>Memory Manager</h1>
        <p style={{ color: "#a7f3d0", maxWidth: 700, lineHeight: 1.6 }}>
          Review what FROSH wants to remember, approve useful context, or forget memories you no longer want stored.
        </p>
      </header>

      {message && <div style={{ marginBottom: 20, padding: 14, border: "1px solid #14532d", borderRadius: 10 }}>{message}</div>}

      {loading ? <p>Loading memory…</p> : (
        <div style={{ display: "grid", gap: 24 }}>
          <section style={{ background: "#0b1b14", border: "1px solid #164e32", borderRadius: 16, padding: 22 }}>
            <h2>Pending approval</h2>
            {!candidates.length && <p style={{ color: "#86a995" }}>No memory candidates waiting for approval.</p>}
            {candidates.map((candidate) => (
              <article key={candidate.id} style={{ padding: "16px 0", borderTop: "1px solid #143d29" }}>
                <strong>{candidate.kind.replace("_", " ")}</strong>
                <p style={{ lineHeight: 1.55 }}>{candidate.statement}</p>
                <small style={{ color: "#86a995" }}>Confidence: {Math.round(candidate.confidence * 100)}%</small>
                <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
                  <button onClick={() => void resolveCandidate(candidate.id, "approved")} style={{ padding: "9px 14px", border: 0, borderRadius: 8, background: "#16a34a", color: "white" }}>Remember</button>
                  <button onClick={() => void resolveCandidate(candidate.id, "rejected")} style={{ padding: "9px 14px", border: "1px solid #365f49", borderRadius: 8, background: "transparent", color: "#d1fae5" }}>Don't remember</button>
                </div>
              </article>
            ))}
          </section>

          <section style={{ background: "#0b1b14", border: "1px solid #164e32", borderRadius: 16, padding: 22 }}>
            <h2>Remembered</h2>
            {!memories.length && <p style={{ color: "#86a995" }}>FROSH has no approved long-term memories yet.</p>}
            {memories.map((memory) => (
              <article key={memory.id} style={{ padding: "16px 0", borderTop: "1px solid #143d29" }}>
                <strong>{memory.kind.replace("_", " ")}</strong>
                <p style={{ lineHeight: 1.55 }}>{memory.statement}</p>
                <button onClick={() => void forget(memory.id)} style={{ padding: "8px 12px", border: "1px solid #7f1d1d", borderRadius: 8, background: "transparent", color: "#fecaca" }}>Forget</button>
              </article>
            ))}
          </section>
        </div>
      )}
    </main>
  );
}
