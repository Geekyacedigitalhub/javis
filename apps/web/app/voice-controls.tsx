"use client";

import { useEffect, useRef, useState } from "react";

type SpeechRecognitionAlternativeLike = { transcript: string; confidence: number };
type SpeechRecognitionResultLike = { isFinal: boolean; 0: SpeechRecognitionAlternativeLike };
type SpeechRecognitionEventLike = { resultIndex: number; results: ArrayLike<SpeechRecognitionResultLike> };
type SpeechRecognitionErrorEventLike = { error: string };

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type VoicePreferences = {
  language: string;
  rate: number;
  autoSpeak: boolean;
};

const PREFERENCES_KEY = "frosh.voice-preferences";
const DEFAULT_PREFERENCES: VoicePreferences = {
  language: "en-NG",
  rate: 1,
  autoSpeak: false,
};

function recognitionConstructor(): SpeechRecognitionConstructor | undefined {
  if (typeof window === "undefined") return undefined;
  const browserWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return browserWindow.SpeechRecognition ?? browserWindow.webkitSpeechRecognition;
}

function loadPreferences(): VoicePreferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_KEY);
    if (!raw) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(raw) as Partial<VoicePreferences>;
    return {
      language: typeof parsed.language === "string" ? parsed.language : DEFAULT_PREFERENCES.language,
      rate: typeof parsed.rate === "number" && parsed.rate >= 0.7 && parsed.rate <= 1.3
        ? parsed.rate
        : DEFAULT_PREFERENCES.rate,
      autoSpeak: parsed.autoSpeak === true,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

export function VoiceControls({
  onTranscript,
  speechText,
  disabled = false,
}: {
  onTranscript: (text: string) => void;
  speechText?: string;
  disabled?: boolean;
}) {
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const lastSpoken = useRef<string | undefined>(undefined);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [status, setStatus] = useState("");
  const [preferences, setPreferences] = useState<VoicePreferences>(DEFAULT_PREFERENCES);

  useEffect(() => {
    setPreferences(loadPreferences());
    return () => {
      recognition.current?.abort();
      window.speechSynthesis?.cancel();
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      // Voice preferences are optional; the controls remain usable without storage.
    }
  }, [preferences]);

  function stopSpeaking() {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }

  function speak(text = speechText) {
    const value = text?.trim();
    if (!value) return;
    if (!("speechSynthesis" in window)) {
      setStatus("Text-to-speech is not available in this browser.");
      return;
    }
    stopSpeaking();
    const utterance = new SpeechSynthesisUtterance(value);
    utterance.lang = preferences.language;
    utterance.rate = preferences.rate;
    utterance.onstart = () => setSpeaking(true);
    utterance.onend = () => setSpeaking(false);
    utterance.onerror = () => {
      setSpeaking(false);
      setStatus("FROSH could not read that response aloud.");
    };
    setStatus("");
    window.speechSynthesis.speak(utterance);
  }

  useEffect(() => {
    const value = speechText?.trim();
    if (!preferences.autoSpeak || !value || value === lastSpoken.current) return;
    lastSpoken.current = value;
    speak(value);
    // `speak` intentionally reads the latest preferences and is invoked only
    // when a new assistant reply arrives or auto-speak is enabled.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speechText, preferences.autoSpeak]);

  function startListening() {
    if (disabled || listening) return;
    const Recognition = recognitionConstructor();
    if (!Recognition) {
      setStatus("Speech recognition is not supported in this browser. Try Chrome or Edge on a secure connection.");
      return;
    }

    const instance = new Recognition();
    instance.continuous = false;
    instance.interimResults = false;
    instance.lang = preferences.language;
    instance.onresult = (event) => {
      let transcript = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) transcript += result[0].transcript;
      }
      if (transcript.trim()) onTranscript(transcript.trim());
    };
    instance.onerror = (event) => {
      setListening(false);
      setStatus(event.error === "not-allowed"
        ? "Microphone permission was denied. Allow it in your browser settings and try again."
        : `Voice input stopped: ${event.error}.`);
    };
    instance.onend = () => setListening(false);
    recognition.current = instance;
    setStatus("");
    try {
      instance.start();
      setListening(true);
    } catch {
      setListening(false);
      setStatus("Voice input could not start. Try again in a moment.");
    }
  }

  function stopListening() {
    recognition.current?.stop();
    setListening(false);
  }

  return (
    <div className="voice-controls">
      <div className="voice-actions">
        <button type="button" onClick={listening ? stopListening : startListening} disabled={disabled}>
          {listening ? "■ Stop listening" : "◉ Speak"}
        </button>
        <button
          type="button"
          onClick={() => (speaking ? stopSpeaking() : speak())}
          disabled={!speechText?.trim()}
        >
          {speaking ? "■ Stop voice" : "↗ Read reply"}
        </button>
        <details className="voice-settings">
          <summary>Voice settings</summary>
          <label>
            Language
            <select
              value={preferences.language}
              onChange={(event) => setPreferences((current) => ({ ...current, language: event.target.value }))}
            >
              <option value="en-NG">English — Nigeria</option>
              <option value="en-US">English — United States</option>
              <option value="en-GB">English — United Kingdom</option>
            </select>
          </label>
          <label>
            Speed
            <input
              aria-label="Voice speed"
              type="range"
              min="0.7"
              max="1.3"
              step="0.1"
              value={preferences.rate}
              onChange={(event) => setPreferences((current) => ({ ...current, rate: Number(event.target.value) }))}
            />
            <span>{preferences.rate.toFixed(1)}×</span>
          </label>
          <label className="voice-checkbox">
            <input
              type="checkbox"
              checked={preferences.autoSpeak}
              onChange={(event) => setPreferences((current) => ({ ...current, autoSpeak: event.target.checked }))}
            />
            Read new replies automatically
          </label>
        </details>
      </div>
      {status && <p className="voice-status" role="status">{status}</p>}
    </div>
  );
}
