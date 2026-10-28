import { EventEmitter, requireNativeModule } from "expo-modules-core";

type NativeSpeechStatus = {
  available: boolean;
  permission: "granted" | "required";
  listening: boolean;
};

type NativeSpeechResult = { accepted: boolean; message: string };

type NativeSpeechEvents = {
  partial: (event: { transcript?: unknown }) => void;
  result: (event: { transcript?: unknown }) => void;
  error: (event: { message?: unknown }) => void;
  state: (event: { listening?: unknown }) => void;
};

type NativeSpeech = EventEmitter<NativeSpeechEvents> & {
  getStatus(): NativeSpeechStatus;
  requestPermission(): boolean;
  start(language?: string): NativeSpeechResult;
  stop(): NativeSpeechResult;
  cancel(): NativeSpeechResult;
};

export type FroshSpeechEvent =
  | { type: "partial"; transcript: string }
  | { type: "result"; transcript: string }
  | { type: "error"; message: string }
  | { type: "state"; listening: boolean };

const native = requireNativeModule<NativeSpeech>("FroshSpeech");

export function getSpeechCapability() {
  const status = native.getStatus();
  return {
    available: status.available,
    permissionRequired: status.permission !== "granted",
    listening: status.listening,
    message: !status.available
      ? "Android speech recognition is unavailable on this device."
      : status.permission !== "granted"
        ? "Microphone permission is required for voice input."
        : "Android voice input is ready.",
  };
}

export function requestSpeechPermission() {
  return native.requestPermission();
}

export function startSpeechInput(language = "en-US") {
  return native.start(language);
}

export function stopSpeechInput() {
  return native.stop();
}

export function cancelSpeechInput() {
  return native.cancel();
}

export function addSpeechListener(listener: (event: FroshSpeechEvent) => void) {
  const subscriptions = [
    native.addListener("partial", (event: { transcript?: unknown }) => {
      if (typeof event.transcript === "string") listener({ type: "partial", transcript: event.transcript });
    }),
    native.addListener("result", (event: { transcript?: unknown }) => {
      if (typeof event.transcript === "string") listener({ type: "result", transcript: event.transcript });
    }),
    native.addListener("error", (event: { message?: unknown }) => {
      listener({ type: "error", message: typeof event.message === "string" ? event.message : "Android speech recognition failed." });
    }),
    native.addListener("state", (event: { listening?: unknown }) => {
      listener({ type: "state", listening: event.listening === true });
    }),
  ];
  return () => subscriptions.forEach((subscription) => subscription.remove());
}
