"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { VoiceControls } from "./voice-controls";

type ChatMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: Array<{ name: string; status: string }>;
};

type Conversation = {
  id: string;
  updatedAt: string;
  preview?: string;
};

const API = "/api/frosh";
const USER_ID = process.env.NEXT_PUBLIC_FROSH_USER_ID ?? "default-user";

function conversationLabel(conversation: Conversation): string {
  const preview = conversation.preview?.replace(/\s+/g, " ").trim();
  if (!preview) return "New conversation";
  return preview.length > 38 ? preview.slice(0, 38) + "…" : preview;
}

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [conversationId, setConversationId] = useState<string>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [error, setError] = useState("");

  async function loadConversations() {
    try {
      const response = await fetch(
        `${API}/v1/conversations/users/${encodeURIComponent(USER_ID)}?limit=30`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load conversations.");
      setConversations(data.conversations ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load conversations.");
    }
  }

  useEffect(() => {
    void loadConversations();
  }, []);

  async function openConversation(id: string) {
    if (id === conversationId || loadingConversation) return;
    setLoadingConversation(true);
    setError("");
    try {
      const response = await fetch(
        `${API}/v1/conversations/users/${encodeURIComponent(USER_ID)}/${encodeURIComponent(id)}?limit=100`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not load this conversation.");
      setMessages((data.messages ?? []).map((message: ChatMessage) => ({
        role: message.role,
        content: message.content,
      })));
      setConversationId(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load this conversation.");
    } finally {
      setLoadingConversation(false);
    }
  }

  function startNewConversation() {
    if (busy) return;
    setConversationId(undefined);
    setMessages([]);
    setInput("");
    setError("");
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message || busy) return;

    setInput("");
    setError("");
    setMessages((current) => [...current, { role: "user", content: message }]);
    setBusy(true);

    try {
      const response = await fetch(`${API}/v1/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ message, conversationId }),
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? "FROSH request failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistant = "";
      let toolCalls: Array<{ name: string; status: string }> = [];
      setMessages((current) => [...current, { role: "assistant", content: "" }]);

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";

        for (const chunk of chunks) {
          const line = chunk.split("\n").find((item) => item.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6));

          if (event.type === "delta") {
            assistant += event.text ?? "";
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              if (last?.role === "assistant") next[next.length - 1] = { ...last, content: assistant, toolCalls };
              return next;
            });
          }

          if (event.type === "tool") {
            toolCalls = [...toolCalls, { name: event.name, status: event.status }];
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              if (last?.role === "assistant") next[next.length - 1] = { ...last, content: assistant, toolCalls };
              return next;
            });
          }

          if (event.type === "done") {
            if (event.conversationId) setConversationId(event.conversationId);
            assistant = event.message ?? assistant;
            toolCalls = event.toolCalls ?? toolCalls;
            setMessages((current) => {
              const next = [...current];
              const last = next[next.length - 1];
              if (last?.role === "assistant") next[next.length - 1] = { ...last, content: assistant, toolCalls };
              return next;
            });
          }

          if (event.type === "error") throw new Error(event.message ?? "Streaming request failed.");
        }
      }
      if (!assistant && !toolCalls.length) {
        throw new Error("FROSH stream ended without a response.");
      }
      await loadConversations();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach FROSH.");
    } finally {
      setBusy(false);
    }
  }

  const latestAssistantReply = [...messages].reverse().find((message) => message.role === "assistant")?.content;

  return (
    <main className="frosh-shell">
      <aside className="sidebar">
        <div className="brand">FROSH</div>
        <div className="eyebrow">PERSONAL AI OS</div>
        <button className="new-chat" onClick={startNewConversation} disabled={busy}>
          + New chat
        </button>
        <nav>
          <Link className="nav-active" href="/">Chat</Link>
          <Link href="/memory">Memory</Link>
          <Link href="/research">Research</Link>
          <Link href="/devices">Devices</Link>
          <Link href="/messages">Messages</Link>
          <Link href="/automations">Automations</Link>
          <Link href="/missions">Missions</Link>
          <Link href="/runs">Runs</Link>
          <Link href="/approvals">Approvals</Link>
        </nav>
        <section className="conversation-list" aria-label="Recent conversations">
          <div className="conversation-list-title">Recent chats</div>
          {!conversations.length && <p className="conversation-empty">Your conversations will appear here.</p>}
          {conversations.map((conversation) => (
            <button
              className={conversation.id === conversationId ? "conversation-active" : ""}
              key={conversation.id}
              onClick={() => void openConversation(conversation.id)}
              disabled={busy || loadingConversation}
              title={conversation.preview ?? "New conversation"}
            >
              {conversationLabel(conversation)}
            </button>
          ))}
        </section>
        <div className="sidebar-status">
          <span className="status-dot" />
          FROSH Core
          <small>Ready for commands</small>
        </div>
      </aside>

      <section className="chat-panel">
        <header className="topbar">
          <div>
            <div className="eyebrow">COMMAND CENTER</div>
            <h1>{conversationId ? "Continue your conversation" : "What can I do for you?"}</h1>
          </div>
          <div className="connection">● LOCAL API</div>
        </header>

        <div className="messages" aria-busy={busy || loadingConversation}>
          {!messages.length && !loadingConversation && (
            <div className="welcome">
              <div className="welcome-orb">F</div>
              <h2>Your AI operating system.</h2>
              <p>
                Ask FROSH to reason, research, code, work with your devices,
                manage memory, or execute approved tools.
              </p>
              <div className="suggestions">
                {["What do you remember about me?", "Check my connected devices", "Help me plan my next project"].map((item) => (
                  <button key={item} onClick={() => setInput(item)}>{item}</button>
                ))}
              </div>
            </div>
          )}

          {loadingConversation && <div className="typing">Loading conversation…</div>}

          {messages.map((message, index) => (
            <article key={index} className={`message ${message.role === "user" ? "user" : "assistant"}`}>
              <div className="message-label">{message.role === "user" ? "YOU" : "FROSH"}</div>
              <div className="message-body">{message.content}</div>
              {message.toolCalls?.length ? (
                <div className="tool-strip">
                  {message.toolCalls.map((tool, toolIndex) => (
                    <span key={toolIndex}>{tool.name} · {tool.status}</span>
                  ))}
                </div>
              ) : null}
            </article>
          ))}

          {busy && <div className="typing">FROSH is thinking…</div>}
        </div>

        {error && <div className="error">{error}</div>}

        <VoiceControls
          disabled={busy || loadingConversation}
          speechText={latestAssistantReply}
          onTranscript={(transcript) => setInput((current) => current ? `${current} ${transcript}` : transcript)}
        />

        <form className="composer" onSubmit={send}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Talk to FROSH…"
            rows={2}
            disabled={busy || loadingConversation}
          />
          <button type="submit" disabled={busy || loadingConversation || !input.trim()}>
            {busy ? "Thinking…" : "Send"}
          </button>
        </form>
      </section>
    </main>
  );
}
