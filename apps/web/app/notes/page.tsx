"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import "./notes.css";

type Note = { id: string; title: string; content: string; tags: string[]; pinned: boolean; taskId?: string; updatedAt: string };
type Task = { id: string; title: string; status: "open" | "in_progress" | "completed" | "cancelled" };

const API = "/api/frosh";
const USER_ID = process.env.NEXT_PUBLIC_FROSH_USER_ID ?? "default-user";

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1_440)}d ago`;
}

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [taskId, setTaskId] = useState("");
  const [pinned, setPinned] = useState(false);
  const [query, setQuery] = useState("");
  const [tag, setTag] = useState("");
  const [status, setStatus] = useState("Loading your knowledge base…");
  const [busy, setBusy] = useState(false);

  const activeTasks = useMemo(() => tasks.filter((task) => task.status === "open" || task.status === "in_progress"), [tasks]);
  const selectedNote = notes.find((note) => note.id === selected) ?? null;
  const allTags = useMemo(() => [...new Set(notes.flatMap((note) => note.tags))].sort((a, b) => a.localeCompare(b)), [notes]);

  function reset() {
    setSelected(null); setTitle(""); setContent(""); setTags(""); setTaskId(""); setPinned(false);
  }

  function choose(note: Note) {
    setSelected(note.id); setTitle(note.title); setContent(note.content); setTags(note.tags.join(", ")); setTaskId(note.taskId ?? ""); setPinned(note.pinned); setStatus("");
  }

  async function load() {
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (tag) params.set("tag", tag);
      params.set("limit", "200");
      const [noteResponse, taskResponse] = await Promise.all([
        fetch(`${API}/v1/notes/users/${encodeURIComponent(USER_ID)}?${params}`, { cache: "no-store" }),
        fetch(`${API}/v1/tasks/users/${encodeURIComponent(USER_ID)}?limit=200`, { cache: "no-store" }),
      ]);
      const noteData = await noteResponse.json();
      const taskData = await taskResponse.json();
      if (!noteResponse.ok) throw new Error(noteData.error ?? "Could not load notes.");
      if (!taskResponse.ok) throw new Error(taskData.error ?? "Could not load tasks.");
      setNotes(noteData.notes ?? []); setTasks(taskData.tasks ?? []); setStatus("");
      if (selected && !(noteData.notes ?? []).some((note: Note) => note.id === selected)) reset();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not reach FROSH."); }
  }

  useEffect(() => { void load(); }, []);

  async function search(event: FormEvent) { event.preventDefault(); await load(); }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!title.trim() || !content.trim() || busy) return;
    setBusy(true);
    const body = { title: title.trim(), content: content.trim(), tags: tags.split(",").map((entry) => entry.trim()).filter(Boolean), pinned, taskId: taskId || null };
    try {
      const response = await fetch(selected
        ? `${API}/v1/notes/users/${encodeURIComponent(USER_ID)}/${encodeURIComponent(selected)}`
        : `${API}/v1/notes/users/${encodeURIComponent(USER_ID)}`, {
        method: selected ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save note.");
      setSelected(data.note.id); setStatus(selected ? "Note saved." : "Note created.");
      await load();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not save note."); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!selected || !selectedNote || !confirm(`Delete “${selectedNote.title}”?`)) return;
    setBusy(true);
    try {
      const response = await fetch(`${API}/v1/notes/users/${encodeURIComponent(USER_ID)}/${encodeURIComponent(selected)}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not delete note.");
      reset(); setStatus("Note deleted."); await load();
    } catch (error) { setStatus(error instanceof Error ? error.message : "Could not delete note."); }
    finally { setBusy(false); }
  }

  return <main className="notes-page">
    <header className="notes-header"><div><Link href="/" className="back">← FROSH Command Center</Link><div className="eyebrow">FROSH / KNOWLEDGE</div><h1>Your notes</h1><p>Keep durable project context, decisions, and runbooks. Pin important notes and link them to the task they support.</p></div><button onClick={() => void load()} disabled={busy}>Refresh</button></header>
    {status && <p className="notes-status" role="status">{status}</p>}
    <section className="notes-workspace">
      <aside className="note-sidebar">
        <form className="note-search" onSubmit={(event) => void search(event)}><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search notes" maxLength={200} /><button>Search</button></form>
        <div className="note-filter"><label>Tag <select value={tag} onChange={(event) => { setTag(event.target.value); }}><option value="">All tags</option>{allTags.map((value) => <option key={value} value={value}>{value}</option>)}</select></label><button onClick={() => { reset(); setStatus("New note"); }} disabled={busy}>+ New note</button></div>
        <div className="note-list">{!notes.length && <p className="empty">No matching notes yet.</p>}{notes.map((note) => <button type="button" className={note.id === selected ? "selected" : ""} key={note.id} onClick={() => choose(note)}><span>{note.pinned ? "★ " : ""}{note.title}</span><small>{relativeTime(note.updatedAt)}</small>{note.tags.length ? <em>{note.tags.join(" · ")}</em> : null}</button>)}</div>
      </aside>
      <section className="note-editor"><form onSubmit={save}>
        <div className="editor-title"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Note title" maxLength={300} required /><label className="pin"><input type="checkbox" checked={pinned} onChange={(event) => setPinned(event.target.checked)} /> Pin in Today</label></div>
        <textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder="Write the context FROSH should help you keep…" maxLength={50000} required />
        <div className="editor-meta"><label>Tags <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="project, decision, runbook" maxLength={1000} /></label><label>Linked task <select value={taskId} onChange={(event) => setTaskId(event.target.value)}><option value="">No linked task</option>{activeTasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label></div>
        <div className="editor-actions"><button disabled={busy || !title.trim() || !content.trim()}>{busy ? "Saving…" : selected ? "Save note" : "Create note"}</button>{selected && <button type="button" className="danger" onClick={() => void remove()} disabled={busy}>Delete</button>}</div>
      </form></section>
    </section>
  </main>;
}
