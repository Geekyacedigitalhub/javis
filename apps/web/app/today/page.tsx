"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import "./today.css";

type TaskStatus = "open" | "in_progress" | "completed" | "cancelled";
type TaskPriority = "low" | "normal" | "high";
type Task = { id: string; title: string; notes?: string; dueAt?: string; status: TaskStatus; priority: TaskPriority; completedAt?: string };
type Briefing = {
  generatedAt: string;
  headline: string;
  tasks: { open: number; overdue: Task[]; dueToday: Task[]; completedToday: Task[] };
  missions: Array<{ id: string; goal: string; status: string }>;
  approvals: Array<{ id: string; toolName: string; reason: string }>;
  notes: { pinned: Array<{ id: string; title: string; content: string; taskId?: string }> };
  monitors: { attention: Array<{ id: string; name: string; health: "degraded" | "down"; lastError?: string }> };
};

const API = "/api/frosh";
const USER_ID = process.env.NEXT_PUBLIC_FROSH_USER_ID ?? "default-user";

export default function TodayPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [status, setStatus] = useState("Loading your briefing…");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [tasksResponse, briefingResponse] = await Promise.all([
        fetch(`${API}/v1/tasks/users/${encodeURIComponent(USER_ID)}?limit=100`, { cache: "no-store" }),
        fetch(`${API}/v1/briefing/users/${encodeURIComponent(USER_ID)}`, { cache: "no-store" }),
      ]);
      const taskData = await tasksResponse.json();
      const briefingData = await briefingResponse.json();
      if (!tasksResponse.ok) throw new Error(taskData.error ?? "Could not load tasks.");
      if (!briefingResponse.ok) throw new Error(briefingData.error ?? "Could not load the daily briefing.");
      setTasks(taskData.tasks ?? []);
      setBriefing(briefingData);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not reach FROSH.");
    }
  }

  useEffect(() => { void load(); }, []);

  async function createTask(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const response = await fetch(`${API}/v1/tasks/users/${encodeURIComponent(USER_ID)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: title.trim(), dueAt: dueAt ? new Date(dueAt).toISOString() : undefined, priority }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not add task.");
      setTitle("");
      setDueAt("");
      setPriority("normal");
      setStatus("Task added.");
      await load();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not add task.");
    } finally {
      setBusy(false);
    }
  }

  async function updateTask(task: Task, patch: Partial<Pick<Task, "status">>) {
    const response = await fetch(`${API}/v1/tasks/users/${encodeURIComponent(USER_ID)}/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = await response.json();
    setStatus(response.ok ? "Task updated." : data.error ?? "Task update failed.");
    await load();
  }

  async function removeTask(task: Task) {
    if (!confirm(`Delete “${task.title}”?`)) return;
    const response = await fetch(`${API}/v1/tasks/users/${encodeURIComponent(USER_ID)}/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    setStatus(response.ok ? "Task deleted." : "Task deletion failed.");
    await load();
  }

  const activeTasks = useMemo(() => tasks.filter((task) => task.status === "open" || task.status === "in_progress"), [tasks]);

  return (
    <main className="today-page">
      <header className="today-header">
        <div>
          <Link href="/" className="back">← FROSH Command Center</Link>
          <div className="eyebrow">FROSH / TODAY</div>
          <h1>Your daily briefing</h1>
          <p>{briefing?.headline ?? "FROSH is collecting your priorities."}</p>
        </div>
        <button onClick={() => void load()}>Refresh</button>
      </header>

      {status && <div className="today-status" role="status">{status}</div>}

      <section className="briefing-grid">
        <article><strong>{briefing?.tasks.open ?? 0}</strong><span>open tasks</span></article>
        <article><strong>{briefing?.tasks.dueToday.length ?? 0}</strong><span>due today</span></article>
        <article><strong>{briefing?.tasks.overdue.length ?? 0}</strong><span>overdue</span></article>
        <article><strong>{briefing?.approvals.length ?? 0}</strong><span>pending approvals</span></article>
        <article><strong>{briefing?.notes.pinned.length ?? 0}</strong><span>pinned notes</span></article>
        <article><strong>{briefing?.monitors.attention.length ?? 0}</strong><span>service alerts</span></article>
      </section>

      <form className="task-create" onSubmit={createTask}>
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Add a task…" maxLength={300} required />
        <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} aria-label="Due date" />
        <select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)} aria-label="Priority">
          <option value="low">Low priority</option><option value="normal">Normal priority</option><option value="high">High priority</option>
        </select>
        <button disabled={busy || !title.trim()}>{busy ? "Adding…" : "Add task"}</button>
      </form>

      <section className="today-columns">
        <div className="task-panel">
          <div className="panel-heading"><h2>Focus list</h2><span>{activeTasks.length} active</span></div>
          {!activeTasks.length && <p className="empty">No active tasks. Add one above or create a mission.</p>}
          {activeTasks.map((task) => (
            <article className={`task-card ${task.priority}`} key={task.id}>
              <button className="task-check" onClick={() => void updateTask(task, { status: "completed" })} aria-label={`Complete ${task.title}`}>○</button>
              <div><strong>{task.title}</strong>{task.dueAt && <small>{Date.parse(task.dueAt) < Date.now() ? "Overdue · " : "Due · "}{new Date(task.dueAt).toLocaleString()}</small>}</div>
              <button className="task-delete" onClick={() => void removeTask(task)}>×</button>
            </article>
          ))}
        </div>
        <aside className="briefing-panel">
          <h2>Needs attention</h2>
          {briefing?.tasks.overdue.map((task) => <p key={task.id}>⚠ <strong>{task.title}</strong> is overdue.</p>)}
          {briefing?.tasks.dueToday.map((task) => <p key={task.id}>◷ <strong>{task.title}</strong> is due today.</p>)}
          {briefing?.approvals.map((approval) => <p key={approval.id}>✓ <Link href="/approvals">{approval.toolName}</Link> needs approval.</p>)}
          {briefing?.notes.pinned.map((note) => <p key={note.id}>▣ <Link href="/notes">{note.title}</Link>{note.taskId ? " · linked to a task" : ""}</p>)}
          {briefing?.monitors.attention.map((monitor) => <p key={monitor.id}>⚠ <Link href="/monitors">{monitor.name}</Link> is {monitor.health}.{monitor.lastError ? ` ${monitor.lastError}` : ""}</p>)}
          {briefing?.missions.map((mission) => <p key={mission.id}>◈ <Link href={`/missions/${mission.id}`}>{mission.goal}</Link> · {mission.status.replace("_", " ")}</p>)}
          {!briefing?.tasks.overdue.length && !briefing?.tasks.dueToday.length && !briefing?.approvals.length && !briefing?.notes.pinned.length && !briefing?.monitors.attention.length && !briefing?.missions.length && <p className="empty">Nothing urgent right now.</p>}
        </aside>
      </section>
    </main>
  );
}
