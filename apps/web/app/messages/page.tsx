"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import "./messaging.css";

type Message = {
  id: string;
  provider: string;
  appName?: string;
  sender?: string;
  text?: string;
  receivedAt: string;
  canReply: boolean;
  priority?: "low" | "normal" | "high" | "urgent";
  likelyNeedsReply?: boolean;
  reason?: string;
};

type Device = { id: string; name: string; platform: string; status: string };

export default function MessagingPage() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [selected, setSelected] = useState<Message | null>(null);
  const [reply, setReply] = useState("");
  const [filter, setFilter] = useState("all");
  const [status, setStatus] = useState("Loading…");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);

  const android = devices.find((item) => item.platform === "android" && item.status === "online");

  async function load() {
    try {
      const devicesResponse = await fetch("/api/frosh/v1/devices", { cache: "no-store" });
      const data = await devicesResponse.json();
      const list = data.devices ?? [];
      setDevices(list);
      const phone = list.find((item: Device) => item.platform === "android" && item.status === "online");
      if (!phone) {
        setStatus("No Android device online.");
        setMessages([]);
        return;
      }
      const response = await fetch(`/api/frosh/v1/devices/${encodeURIComponent(phone.id)}/messages/intelligence`, { cache: "no-store" });
      const intelligence = await response.json();
      if (!response.ok || intelligence.accepted === false) throw new Error(intelligence.message ?? "Unable to load messages.");
      setMessages(intelligence.highlights ?? []);
      setStatus(`${intelligence.total ?? 0} messages • ${intelligence.needsReply ?? 0} need attention • ${intelligence.urgent ?? 0} urgent`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Messaging unavailable.");
    }
  }

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const visible = useMemo(() => {
    if (filter === "needs-reply") return messages.filter((item) => item.likelyNeedsReply);
    if (filter === "urgent") return messages.filter((item) => item.priority === "urgent");
    return messages;
  }, [messages, filter]);

  const groups = useMemo(() => {
    const map = new Map<string, Message[]>();
    for (const item of visible) {
      const key = `${item.provider}:${item.sender ?? "Unknown"}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    }
    return [...map.entries()];
  }, [visible]);

  async function suggestReplies() {
    if (!selected?.text) return;
    setSuggesting(true);
    setStatus("FROSH is drafting replies…");
    try {
      const response = await fetch(`/api/frosh/v1/devices/${encodeURIComponent(android?.id ?? "")}/messages/suggest-replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: selected.provider, sender: selected.sender, message: selected.text })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not generate replies.");
      setSuggestions(data.suggestions ?? []);
      setStatus("Reply drafts ready. Choose one to edit before sending.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Reply suggestions failed.");
    } finally {
      setSuggesting(false);
    }
  }

  async function sendReply() {
    if (!android || !selected || !reply.trim()) return;
    setStatus("Sending reply…");
    const response = await fetch(
      `/api/frosh/v1/devices/${encodeURIComponent(android.id)}/messages/${encodeURIComponent(selected.id)}/reply`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: reply.trim() }) }
    );
    const data = await response.json();
    setStatus(data.message ?? "Reply completed.");
    if (response.ok && data.accepted) {
      setReply("");
      setSelected(null);
      void load();
    }
  }

  return (
    <main className="messaging-page">
      <header className="messaging-header">
        <div>
          <Link href="/" className="back">← FROSH Command Center</Link>
          <div className="eyebrow">FROSH / MESSAGES</div>
          <h1>Unified Inbox</h1>
          <p>One view for supported Android messaging notifications, with FROSH priority detection.</p>
        </div>
        <button className="refresh" onClick={() => void load()}>Refresh</button>
      </header>

      <div className="message-status">{status}</div>
      <div className="filters">
        {[
          ["all", "All"],
          ["needs-reply", "Needs reply"],
          ["urgent", "Urgent"]
        ].map(([value, label]) => (
          <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>
        ))}
      </div>

      {!groups.length ? (
        <section className="message-empty">
          <h2>No messages to show</h2>
          <p>Pair an Android phone and enable notification access for WhatsApp, Telegram, Messenger, Instagram, Discord or SMS notifications.</p>
        </section>
      ) : (
        <section className="conversation-grid">
          {groups.map(([key, items]) => {
            const latest = items[0];
            return (
              <article className="conversation-card" key={key}>
                <div className="conversation-head">
                  <div>
                    <strong>{latest.sender ?? "Unknown"}</strong>
                    <small>{latest.provider.toUpperCase()} · {latest.appName ?? latest.provider}</small>
                  </div>
                  <span className={`priority ${latest.priority}`}>{latest.priority}</span>
                </div>
                <div className="conversation-body">
                  {items.slice(0, 4).map((item) => (
                    <button key={item.id} className={`message-item ${item.likelyNeedsReply ? "needs-reply" : ""}`} onClick={() => setSelected(item)}>
                      <span>{item.text || "Notification without text"}</span>
                      <time>{new Date(item.receivedAt).toLocaleString()}</time>
                    </button>
                  ))}
                </div>
                <footer>{items.length} recent message{items.length === 1 ? "" : "s"}</footer>
              </article>
            );
          })}
        </section>
      )}

      {selected && (
        <div className="reply-overlay" onClick={() => setSelected(null)}>
          <div className="reply-modal" onClick={(event) => event.stopPropagation()}>
            <div className="eyebrow">REPLY</div>
            <h2>{selected.sender ?? "Message"}</h2>
            <p className="selected-message">{selected.text}</p>
            <button className="suggest" onClick={() => void suggestReplies()} disabled={suggesting || !android}>
              {suggesting ? "FROSH is thinking…" : "✨ Suggest replies"}
            </button>
            {suggestions.length > 0 && (
              <div className="suggestions">
                {suggestions.map((item, index) => (
                  <button key={index} onClick={() => setReply(item)}>{item}</button>
                ))}
              </div>
            )}
            <textarea value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Write your reply…" />
            <div className="reply-actions">
              <button className="cancel" onClick={() => setSelected(null)}>Cancel</button>
              <button className="send" onClick={() => void sendReply()} disabled={!selected.canReply || !reply.trim()}>Send reply</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
