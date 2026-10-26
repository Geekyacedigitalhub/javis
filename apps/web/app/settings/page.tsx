"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import "./settings.css";

type Preferences = {
  mode: "normal" | "focus" | "coding" | "research" | "voice" | "quiet" | "autonomous";
  personality: "helpful" | "direct" | "warm" | "formal";
  responseLength: "short" | "balanced" | "detailed";
  technicalDepth: "plain" | "adaptive" | "expert";
  autonomyLevel: "confirm" | "safe" | "trusted";
  notificationStyle: "all" | "important" | "quiet";
  voiceLanguage: string;
};

const API = "/api/frosh";
const USER_ID = process.env.NEXT_PUBLIC_FROSH_USER_ID ?? "default-user";

export default function SettingsPage() {
  const [preferences, setPreferences] = useState<Preferences | null>(null);
  const [status, setStatus] = useState("Loading preferences…");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch(`${API}/v1/preferences/users/${encodeURIComponent(USER_ID)}`, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "Could not load preferences.");
        setPreferences(data.preferences);
        setStatus("");
      } catch (error) {
        setStatus(error instanceof Error ? error.message : "Could not load preferences.");
      }
    })();
  }, []);

  function update<K extends keyof Preferences>(key: K, value: Preferences[K]) {
    setPreferences((current) => current ? { ...current, [key]: value } : current);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!preferences || saving) return;
    setSaving(true);
    setStatus("");
    try {
      const response = await fetch(`${API}/v1/preferences/users/${encodeURIComponent(USER_ID)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(preferences),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not save preferences.");
      setPreferences(data.preferences);
      setStatus("Preferences saved. New FROSH replies will follow these settings.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save preferences.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="settings-page">
      <header>
        <Link href="/" className="back">← FROSH Command Center</Link>
        <div className="eyebrow">FROSH / SETTINGS</div>
        <h1>Make FROSH yours</h1>
        <p>These preferences are stored on your FROSH account and are added to new AI conversations without bypassing permission or approval controls.</p>
      </header>

      {status && <div className="settings-status" role="status">{status}</div>}
      {!preferences ? null : (
        <form className="settings-form" onSubmit={save}>
          <section>
            <h2>Operating mode</h2>
            <p>Sets FROSH’s default working context. Safety and approval rules always remain active.</p>
            <div className="settings-options">
              {[
                ["normal", "Normal", "Balanced everyday assistant"], ["focus", "Focus", "Fewer interruptions"],
                ["coding", "Coding", "Technical implementation support"], ["research", "Research", "Evidence-first investigation"],
                ["voice", "Voice", "Short spoken responses"], ["quiet", "Quiet", "Low-notification mode"],
                ["autonomous", "Autonomous", "Use permitted safe actions proactively"],
              ].map(([value, label, description]) => (
                <label className={preferences.mode === value ? "selected" : ""} key={value}>
                  <input type="radio" name="mode" value={value} checked={preferences.mode === value} onChange={() => update("mode", value as Preferences["mode"])} />
                  <strong>{label}</strong><span>{description}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="settings-grid">
            <label>Personality<select value={preferences.personality} onChange={(event) => update("personality", event.target.value as Preferences["personality"])}><option value="helpful">Helpful</option><option value="direct">Direct</option><option value="warm">Warm</option><option value="formal">Formal</option></select></label>
            <label>Response length<select value={preferences.responseLength} onChange={(event) => update("responseLength", event.target.value as Preferences["responseLength"])}><option value="short">Short</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select></label>
            <label>Technical depth<select value={preferences.technicalDepth} onChange={(event) => update("technicalDepth", event.target.value as Preferences["technicalDepth"])}><option value="plain">Plain language</option><option value="adaptive">Adaptive</option><option value="expert">Expert</option></select></label>
            <label>Autonomy<select value={preferences.autonomyLevel} onChange={(event) => update("autonomyLevel", event.target.value as Preferences["autonomyLevel"])}><option value="confirm">Confirm actions</option><option value="safe">Safe actions automatically</option><option value="trusted">Trusted tools when allowed</option></select></label>
            <label>Notifications<select value={preferences.notificationStyle} onChange={(event) => update("notificationStyle", event.target.value as Preferences["notificationStyle"])}><option value="all">All updates</option><option value="important">Important only</option><option value="quiet">Quiet</option></select></label>
            <label>Voice language<select value={preferences.voiceLanguage} onChange={(event) => update("voiceLanguage", event.target.value)}><option value="en-NG">English — Nigeria</option><option value="en-US">English — United States</option><option value="en-GB">English — United Kingdom</option></select></label>
          </section>
          <button className="save-preferences" disabled={saving}>{saving ? "Saving…" : "Save preferences"}</button>
        </form>
      )}
    </main>
  );
}
