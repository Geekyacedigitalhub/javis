"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { VoiceControls } from "./voice-controls";

type ChatMessage = {
  id?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: Array<{ name: string; status: string }>;
};

type Conversation = {
  id: string;
  updatedAt: string;
  preview?: string;
};

type AssistantStatus = {
  provider: "gemini" | "openai" | "development";
  configured: boolean;
  model?: string;
  message: string;
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
  const [assistantStatus, setAssistantStatus] = useState<AssistantStatus | null>(null);
  const activeResponse = useRef<AbortController | null>(null);

  async function loadAssistantStatus() {
    try {
      const response = await fetch(`${API}/v1/assistant/status`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.assistant || typeof data.assistant.configured !== "boolean") {
        throw new Error("Could not load assistant status.");
      }
      setAssistantStatus(data.assistant as AssistantStatus);
    } catch {
      // Chat itself will report an actionable error if the API is unavailable.
      setAssistantStatus(null);
    }
  }

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
    void loadAssistantStatus();
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

  async function sendMessage(rawMessage: string) {
    const message = rawMessage.trim();
    if (!message || busy) return;

    const controller = new AbortController();
    const assistantId = `stream-${Date.now()}`;
    let assistant = "";
    let toolCalls: Array<{ name: string; status: string }> = [];
    let completed = false;
    let completedConversationId: string | undefined;
    activeResponse.current = controller;
    setInput("");
    setError("");
    setMessages((current) => [...current, { role: "user", content: message }]);
    setBusy(true);

    const updateAssistant = () => {
      setMessages((current) => current.map((item) => item.id === assistantId
        ? { ...item, content: assistant, toolCalls }
        : item));
    };

    try {
      const response = await fetch(`${API}/v1/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "text/event-stream" },
        body: JSON.stringify({ message, conversationId }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error ?? "FROSH request failed.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedBytes = 0;
      const maxStreamBytes = 2 * 1024 * 1024;
      setMessages((current) => [...current, { id: assistantId, role: "assistant", content: "" }]);

      try {
        while (true) {
          if (controller.signal.aborted) throw new Error("FROSH response was cancelled.");
          const { value, done } = await reader.read();
          if (controller.signal.aborted) throw new Error("FROSH response was cancelled.");
          if (done) break;
          receivedBytes += value.byteLength;
          if (receivedBytes > maxStreamBytes) throw new Error("FROSH response exceeded the safe streaming limit.");
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split(/\r?\n\r?\n/);
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const data = frame.split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            if (!data || data === "[DONE]") continue;
            let event: any;
            try { event = JSON.parse(data); } catch { throw new Error("FROSH returned an invalid live response."); }

            if (event.type === "delta") {
              assistant += typeof event.text === "string" ? event.text : "";
              updateAssistant();
            } else if (event.type === "tool") {
              if (typeof event.name === "string" && typeof event.status === "string") {
                toolCalls = [...toolCalls, { name: event.name, status: event.status }];
                updateAssistant();
              }
            } else if (event.type === "done") {
              if (typeof event.conversationId !== "string" || typeof event.message !== "string") {
                throw new Error("FROSH returned an invalid live response.");
              }
              completed = true;
              completedConversationId = event.conversationId;
              assistant = event.message || assistant;
              toolCalls = Array.isArray(event.toolCalls) ? event.toolCalls : toolCalls;
              updateAssistant();
            } else if (event.type === "error") {
              throw new Error(typeof event.message === "string" ? event.message : "Streaming request failed.");
            } else {
              throw new Error("FROSH returned an invalid live response.");
            }
          }
        }
      } finally {
        reader.releaseLock();
      }

      if (!completed || !completedConversationId) throw new Error("FROSH live response ended before completion.");
      // The HTTP stream closes only after the API has saved the assistant turn.
      // Never advance the durable conversation for a cancelled/failed stream.
      setConversationId(completedConversationId);
      await loadConversations();
    } catch (cause) {
      setMessages((current) => current.filter((item) => item.id !== assistantId));
      if (controller.signal.aborted) {
        setInput(message);
        setError("FROSH response stopped. Partial text was not kept as a completed turn; refresh this chat if you stopped it at the end of a response.");
      } else {
        setError(cause instanceof Error ? cause.message : "Could not reach FROSH.");
      }
    } finally {
      if (activeResponse.current === controller) activeResponse.current = null;
      setBusy(false);
    }
  }

  function stopResponse() {
    const controller = activeResponse.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort();
    setError("Stopping FROSH response…");
  }

  function send(event: FormEvent) {
    event.preventDefault();
    void sendMessage(input);
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
          <Link href="/today">Today</Link>
          <Link href="/memory">Memory</Link>
          <Link href="/notes">Notes</Link>
          <Link href="/research">Research</Link>
          <Link href="/devices">Devices</Link>
          <Link href="/messages">Messages</Link>
          <Link href="/automations">Automations</Link>
          <Link href="/monitors">Monitors</Link>
          <Link href="/missions">Missions</Link>
          <Link href="/runs">Runs</Link>
          <Link href="/approvals">Approvals</Link>
          <Link href="/settings">Settings</Link>
          <Link href="/integrations">Integrations</Link>
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
        <div className={`sidebar-status ${assistantStatus?.configured ? "assistant-online" : "assistant-setup"}`}>
          <span className="status-dot" />
          {assistantStatus?.configured ? "AI brain online" : "AI brain setup needed"}
          <small>{assistantStatus?.configured
            ? `${assistantStatus.provider.toUpperCase()}${assistantStatus.model ? ` · ${assistantStatus.model}` : ""}`
            : "No live model is configured"}</small>
        </div>
      </aside>

      <section className="chat-panel">
        <header className="topbar">
          <div>
            <div className="eyebrow">COMMAND CENTER</div>
            <h1>{conversationId ? "Continue your conversation" : "What can I do for you?"}</h1>
          </div>
          <div className={`connection ${assistantStatus?.configured ? "connection-ready" : "connection-warning"}`}>
            ● {assistantStatus?.configured ? "AI READY" : "AI SETUP NEEDED"}
          </div>
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
        {assistantStatus && !assistantStatus.configured && (
          <div className="assistant-setup-note" role="status">
            <strong>FROSH is not pretending to be an AI yet.</strong> {assistantStatus.message}
          </div>
        )}

        <VoiceControls
          disabled={busy || loadingConversation}
          speechText={latestAssistantReply}
          onTranscript={(transcript) => void sendMessage(transcript)}
        />

        <form className="composer" onSubmit={send}>
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Talk to FROSH…"
            rows={2}
            disabled={busy || loadingConversation}
          />
          {busy ? (
            <button type="button" className="stop-response" onClick={stopResponse}>
              Stop
            </button>
          ) : (
            <button type="submit" disabled={loadingConversation || !input.trim()}>
              Send
            </button>
          )}
        </form>
      </section>
    </main>
  );
}
