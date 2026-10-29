import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { CameraView, useCameraPermissions } from "expo-camera";
import * as Speech from "expo-speech";
import type { FroshDevice } from "../../packages/types/src/device";
import type { FroshAgentRun } from "../../packages/types/src/agent-run";
import { analyzeVision, getAssistantStatus, getConversation, listConversations, listDevices, registerDevice, resolveApproval, setDeviceCredential, startAgentRun, streamMessage, type FroshAssistantStatus, type FroshConversationMessage, type FroshConversationSummary } from "./src/api";
import { connectFroshRealtime } from "./src/realtime";
import type { FroshApprovalRequest } from "../../packages/types/src/approval";
import type { FroshNotification } from "../../packages/types/src/notifications";
import { loadDeviceCredential } from "./src/session";
import { runNativePhoneAction } from "./src/native-bridge";
import { controlMedia, readMediaState } from "./src/media-bridge";
import { listInstalledApps } from "./modules/frosh-apps/src";
import { getMediaState, openMediaAccessSettings } from "./src/media";
import { getNotificationCapability, getRecentNotifications, openNotificationSettings, replyToNotification } from "./modules/frosh-notifications/src";
import { getCallPermissionStatus } from "./modules/frosh-calls/src";
import { getContactsCapability } from "./modules/frosh-contacts/src";
import { getMessagingPermissionStatus } from "./modules/frosh-messaging/src";
import { addSpeechListener, cancelSpeechInput, getSpeechCapability, requestSpeechPermission, startSpeechInput, stopSpeechInput } from "./modules/frosh-speech/src";

function conversationLabel(conversation: FroshConversationSummary) {
  const preview = conversation.preview?.replace(/\s+/g, " ").trim();
  if (!preview) return "New conversation";
  return preview.length > 54 ? `${preview.slice(0, 54)}…` : preview;
}

export default function App() {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("FROSH is ready.");
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<FroshDevice[]>([]);
  const [run, setRun] = useState<FroshAgentRun | null>(null);
  const [approval, setApproval] = useState<FroshApprovalRequest | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<"connecting" | "open" | "closed">("closed");
  const [paired, setPaired] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [deviceName, setDeviceName] = useState("My Android Phone");
  const [enrollmentToken, setEnrollmentToken] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [mediaMessage, setMediaMessage] = useState("Media controls unavailable until Android MediaSession access is connected.");
  const [notifications, setNotifications] = useState<FroshNotification[]>([]);
  const [notificationAccess, setNotificationAccess] = useState("checking");
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");
  const [installedApps, setInstalledApps] = useState<Array<{ packageName: string; name: string }>>([]);
  const [assistantStatus, setAssistantStatus] = useState<FroshAssistantStatus | null>(null);
  const [visionPrompt, setVisionPrompt] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [listening, setListening] = useState(false);
  const [voiceInputStatus, setVoiceInputStatus] = useState("checking Android voice input");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [conversations, setConversations] = useState<FroshConversationSummary[]>([]);
  const [conversationMessages, setConversationMessages] = useState<FroshConversationMessage[]>([]);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [conversationError, setConversationError] = useState("");
  const cameraRef = useRef<CameraView>(null);
  const busyRef = useRef(false);

  function refreshAssistantStatus() {
    return getAssistantStatus().then((result) => setAssistantStatus(result.assistant)).catch(() => setAssistantStatus(null));
  }

  async function refreshConversations() {
    try {
      const result = await listConversations();
      setConversations(result.conversations);
      setConversationError("");
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : "Could not load conversation history.");
    }
  }

  async function openConversation(id: string) {
    if (id === conversationId || loadingConversation || busyRef.current) return;
    setLoadingConversation(true);
    setConversationError("");
    try {
      const result = await getConversation(id);
      setConversationId(id);
      setConversationMessages(result.messages.filter((item) => item.role === "user" || item.role === "assistant"));
      const latestReply = [...result.messages].reverse().find((item) => item.role === "assistant")?.content;
      if (latestReply) setReply(latestReply);
    } catch (error) {
      setConversationError(error instanceof Error ? error.message : "Could not open this conversation.");
    } finally {
      setLoadingConversation(false);
    }
  }

  function startNewConversation() {
    if (busyRef.current || loadingConversation) return;
    setConversationId(undefined);
    setConversationMessages([]);
    setMessage("");
    setConversationError("");
    setReply("New conversation ready.");
  }

  useEffect(() => {
    try {
      const capability = getNotificationCapability();
      setNotificationAccess(capability.available ? "active" : "permission required");
      if (capability.available) getRecentNotifications().then(setNotifications).catch(() => undefined);
      try { setInstalledApps(listInstalledApps().slice(0, 20)); } catch { setInstalledApps([]); }
    } catch {
      setNotificationAccess("native module unavailable");
    }

    loadDeviceCredential().then((saved) => {
      if (!saved) return;
      setDeviceCredential(saved);
      setPaired(true);
      listDevices().then((result) => setDevices(result.devices)).catch(() => undefined);
      void refreshAssistantStatus();
      void refreshConversations();
    });
  }, []);

  useEffect(() => {
    if (!paired) return;
    return connectFroshRealtime((event) => {
      if (event.type === "run.updated") setRun(event.run);
      if (event.type === "approval.created") setApproval(event.approval);
    }, setRealtimeStatus);
  }, [paired]);

  useEffect(() => {
    try {
      const capability = getSpeechCapability();
      setVoiceInputStatus(capability.message);
      setListening(capability.listening);
      return addSpeechListener((event) => {
        if (event.type === "partial") setMessage(event.transcript);
        if (event.type === "result") {
          setMessage(event.transcript);
          void submitMessage(event.transcript);
        }
        if (event.type === "error") {
          setListening(false);
          setReply(event.message);
        }
        if (event.type === "state") setListening(event.listening);
      });
    } catch {
      setVoiceInputStatus("Android voice input is unavailable in this app build.");
    }
  }, []);

  async function pairPhone() {
    setPairing(true);
    try {
      const capabilities = [
        "device.info",
        "apps.launch",
        "calls.dialer",
        "messages.compose",
        ...(getCallPermissionStatus() === "available" ? ["calls.direct"] : []),
        ...(getMessagingPermissionStatus() === "available" ? ["messages.send"] : []),
        ...(getContactsCapability().available ? ["contacts.read"] : []),
        ...(getNotificationCapability().available ? ["notifications.read", "notifications.reply"] : []),
      ];
      try {
        const mediaModule = require("./modules/frosh-media/src").default as { getPermissionStatus(): string };
        if (mediaModule.getPermissionStatus() === "available") capabilities.push("media.control");
      } catch {
        // Media capability stays absent when the native module or permission is unavailable.
      }
      const device = await registerDevice(deviceName.trim() || "My Android Phone", capabilities, enrollmentToken);
      setPaired(true);
      setEnrollmentToken("");
      setDevices([device]);
      await refreshAssistantStatus();
      await refreshConversations();
    } catch (error) {
      setReply(error instanceof Error ? error.message : "Pairing failed.");
    } finally {
      setPairing(false);
    }
  }

  async function submitMessage(value: string) {
    if (!value || busyRef.current || loadingConversation) return;
    busyRef.current = true;
    setBusy(true);
    const localId = `local-${Date.now()}`;
    const assistantId = `${localId}-assistant`;
    let assistantText = "";
    let hasAssistantTurn = false;
    let completed = false;
    let completedConversationId: string | undefined;
    setConversationMessages((current) => [...current, {
      id: localId,
      role: "user",
      content: value,
      createdAt: new Date().toISOString(),
    }]);
    try {
      await streamMessage(value, conversationId, (event) => {
        if (event.type === "delta") {
          assistantText += event.text;
          if (!hasAssistantTurn) {
            hasAssistantTurn = true;
            setConversationMessages((current) => [...current, { id: assistantId, role: "assistant", content: assistantText, createdAt: new Date().toISOString() }]);
          } else {
            setConversationMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: assistantText } : item));
          }
          return;
        }
        if (event.type === "tool") {
          setReply(`FROSH ${event.status === "planned" ? "is preparing" : event.status === "completed" ? "completed" : "could not complete"} ${event.name.replace(/_/g, " ")}.`);
          return;
        }
        if (event.type === "approval") {
          setReply("FROSH is waiting for your approval before continuing.");
          return;
        }

        completed = true;
        completedConversationId = event.conversationId;
        const finalMessage = event.message || assistantText;
        if (!hasAssistantTurn && finalMessage) {
          hasAssistantTurn = true;
          setConversationMessages((current) => [...current, { id: assistantId, role: "assistant", content: finalMessage, createdAt: new Date().toISOString() }]);
        } else if (hasAssistantTurn) {
          setConversationMessages((current) => current.map((item) => item.id === assistantId ? { ...item, content: finalMessage } : item));
        }
        assistantText = finalMessage;
      });
      if (!completed || !completedConversationId) throw new Error("FROSH live response ended before completion.");
      // The stream only returns after the server has persisted the final turn.
      // Do not advance durable conversation state for an interrupted stream.
      setConversationId(completedConversationId);
      setReply(assistantText || "FROSH completed the response.");
      setMessage("");
      if (assistantText) speakReply(assistantText);
      await refreshConversations();
    } catch (error) {
      // Keep the compose text for retry, but do not display an interrupted
      // delta as a completed assistant turn.
      setConversationMessages((current) => current.filter((item) => item.id !== assistantId));
      setReply(error instanceof Error ? error.message : "FROSH request failed.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function ask() {
    await submitMessage(message.trim());
  }

  function speakReply(text: string) {
    Speech.stop();
    Speech.speak(text.slice(0, 4_000), { language: "en-US", rate: 0.95 });
  }

  function startVoiceInput() {
    if (!paired) {
      setReply("Pair this phone before submitting a voice command to FROSH.");
      return;
    }
    try {
      const capability = getSpeechCapability();
      setVoiceInputStatus(capability.message);
      if (!capability.available) {
        setReply(capability.message);
        return;
      }
      if (capability.permissionRequired) {
        requestSpeechPermission();
        setReply("Allow microphone access, then tap Voice again.");
        return;
      }
      const result = startSpeechInput();
      setReply(result.message);
      setListening(result.accepted);
    } catch {
      setVoiceInputStatus("Android voice input is unavailable in this app build.");
      setReply("Update to a FROSH build with Android voice input enabled.");
    }
  }

  function stopVoiceInput(cancel = false) {
    try {
      const result = cancel ? cancelSpeechInput() : stopSpeechInput();
      setReply(result.message);
      if (cancel) setListening(false);
    } catch {
      setListening(false);
      setReply("Android voice input is unavailable in this app build.");
    }
  }

  async function openCamera() {
    if (!paired) {
      setReply("Pair this phone before using protected visual analysis.");
      return;
    }
    if (!cameraPermission?.granted) {
      const permission = await requestCameraPermission();
      if (!permission.granted) {
        setReply("Camera permission is required to analyze a photo.");
        return;
      }
    }
    setCameraOpen(true);
  }

  async function captureAndAnalyze() {
    if (busyRef.current || !cameraRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.55, exif: false });
      if (!photo?.base64) throw new Error("FROSH could not capture a usable photo.");
      setCameraOpen(false);
      const result = await analyzeVision(photo.base64, "image/jpeg", visionPrompt);
      setReply(result.message);
      speakReply(result.message);
    } catch (error) {
      setReply(error instanceof Error ? error.message : "FROSH could not analyze that photo.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function startTask() {
    const value = message.trim();
    if (!value || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await startAgentRun(value);
      setRun(result);
      setMessage("");
      setReply(result.result ?? "FROSH started the task.");
    } catch (error) {
      setReply(error instanceof Error ? error.message : "Could not start task.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.container}>
        {!paired ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Pair This Phone</Text>
            <Text style={styles.reply}>Connect this Android device to your private FROSH account before using protected capabilities.</Text>
            <TextInput value={deviceName} onChangeText={setDeviceName} placeholder="Device name" placeholderTextColor="#6b7280" style={styles.inputSingle} />
            <TextInput value={enrollmentToken} onChangeText={setEnrollmentToken} placeholder="Enrollment token" placeholderTextColor="#6b7280" secureTextEntry autoCapitalize="none" autoCorrect={false} style={styles.inputSingle} />
            <Text style={styles.muted}>The enrollment token is used only to pair this phone and is not saved on the device.</Text>
            <Pressable style={styles.primary} onPress={pairPhone} disabled={pairing}>
              {pairing ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>PAIR PHONE</Text>}
            </Pressable>
          </View>
        ) : null}
        <Text style={styles.eyebrow}>PERSONAL AI OPERATING SYSTEM</Text>
        <Text style={styles.title}>FROSH</Text>
        <Text style={styles.status}>● {realtimeStatus === "open" ? "LIVE" : realtimeStatus.toUpperCase()}</Text>
        <Text style={assistantStatus?.configured ? styles.aiReady : styles.aiSetup}>
          {assistantStatus?.configured
            ? `AI READY · ${assistantStatus.provider.toUpperCase()}${assistantStatus.model ? ` · ${assistantStatus.model}` : ""}`
            : "AI SETUP NEEDED · no live model is configured"}
        </Text>

        {paired ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Apps</Text>
            <Text style={styles.reply}>Installed launchable apps: {installedApps.length ? installedApps.length : "unavailable"}</Text>
            {installedApps.slice(0, 8).map((app) => (
              <View key={app.packageName} style={styles.notification}>
                <Text style={styles.device}>{app.name}</Text>
                <Text style={styles.muted}>{app.packageName}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {paired ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Notifications</Text>
            <Text style={styles.reply}>Access: {notificationAccess}</Text>
            <View style={styles.actions}>
              <Pressable style={styles.secondary} onPress={() => openNotificationSettings()}><Text style={styles.secondaryText}>OPEN ACCESS</Text></Pressable>
              <Pressable style={styles.primary} onPress={() => getRecentNotifications().then(setNotifications).catch(() => undefined)}><Text style={styles.primaryText}>REFRESH</Text></Pressable>
            </View>
            {notifications.slice(0, 8).map((item) => (
              <View key={item.id} style={styles.notification}>
                <Text style={styles.device}>{item.title ?? item.packageName}</Text>
                {item.text ? <Text style={styles.muted}>{item.text}</Text> : null}
                {item.canReply ? (
                  <>
                    {replyingTo === item.id ? (
                      <View style={styles.replyRow}>
                        <TextInput value={replyText} onChangeText={setReplyText} placeholder="Reply..." placeholderTextColor="#6b7280" style={styles.input} />
                        <Pressable style={styles.primary} onPress={async () => {
                          const result = await replyToNotification(item.id, replyText);
                          setReplyingTo(null);
                          setReplyText("");
                          setMediaMessage(result.message);
                        }}><Text style={styles.primaryText}>SEND</Text></Pressable>
                      </View>
                    ) : (
                      <Pressable style={styles.secondary} onPress={() => { setReplyingTo(item.id); setReplyText(""); }}>
                        <Text style={styles.secondaryText}>REPLY</Text>
                      </Pressable>
                    )}
                  </>
                ) : null}
              </View>
            ))}
          </View>
        ) : null}

        {paired ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Media</Text>
            <Text style={styles.reply}>{mediaMessage}</Text>
            <Pressable style={styles.secondary} onPress={() => openMediaAccessSettings()}><Text style={styles.secondaryText}>OPEN MEDIA ACCESS</Text></Pressable>
            <View style={styles.actions}>
              <Pressable style={styles.secondary} onPress={() => controlMedia({ action: "previous" }).then((r) => setMediaMessage(r.message))}><Text style={styles.secondaryText}>PREV</Text></Pressable>
              <Pressable style={styles.primary} onPress={() => controlMedia({ action: "toggle" }).then((r) => setMediaMessage(r.message))}><Text style={styles.primaryText}>PLAY / PAUSE</Text></Pressable>
              <Pressable style={styles.secondary} onPress={() => controlMedia({ action: "next" }).then((r) => setMediaMessage(r.message))}><Text style={styles.secondaryText}>NEXT</Text></Pressable>
            </View>
            <Pressable style={styles.secondary} onPress={() => readMediaState().then((r) => setMediaMessage(r.message ?? (r.title ? `${r.title} — ${r.artist ?? "Unknown artist"}` : "No active media.")))}><Text style={styles.secondaryText}>READ CURRENT MEDIA</Text></Pressable>
          </View>
        ) : null}

        {paired ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Phone Actions</Text>
            <TextInput value={phoneNumber} onChangeText={setPhoneNumber} placeholder="Phone number" placeholderTextColor="#6b7280" keyboardType="phone-pad" style={styles.inputSingle} />
            <View style={styles.actions}>
              <Pressable style={styles.secondary} onPress={() => runNativePhoneAction({ action: "open_dialer" }).then((result) => setReply(result.message)).catch((error) => setReply(String(error)))}><Text style={styles.secondaryText}>DIALER</Text></Pressable>
              <Pressable style={styles.primary} onPress={() => runNativePhoneAction({ action: "call_number", value: phoneNumber }).then((result) => setReply(result.message)).catch((error) => setReply(String(error)))}><Text style={styles.primaryText}>CALL</Text></Pressable>
            </View>
            <Pressable style={styles.secondary} onPress={() => runNativePhoneAction({ action: "compose_message", value: phoneNumber }).then((result) => setReply(result.message)).catch((error) => setReply(String(error)))}><Text style={styles.secondaryText}>MESSAGE</Text></Pressable>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Visual Assist</Text>
          <Text style={styles.reply}>Take a photo for a one-time Gemini analysis. The photo is sent only for this request and is not saved by FROSH.</Text>
          {!assistantStatus?.configured ? <Text style={styles.warning}>A live Gemini model must be configured before visual analysis is available.</Text> : null}
          {cameraOpen ? (
            <>
              <CameraView ref={cameraRef} style={styles.camera} facing="back" />
              <View style={styles.actions}>
                <Pressable style={styles.primary} onPress={captureAndAnalyze} disabled={busy}>
                  {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>CAPTURE & ANALYZE</Text>}
                </Pressable>
                <Pressable style={styles.secondary} onPress={() => setCameraOpen(false)} disabled={busy}><Text style={styles.secondaryText}>CANCEL</Text></Pressable>
              </View>
            </>
          ) : (
            <>
              <TextInput value={visionPrompt} onChangeText={setVisionPrompt} placeholder="Optional: what should FROSH look for?" placeholderTextColor="#6b7280" multiline style={styles.input} />
              <Pressable style={styles.secondary} onPress={openCamera} disabled={busy}><Text style={styles.secondaryText}>OPEN CAMERA</Text></Pressable>
            </>
          )}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Conversations</Text>
          <Text style={styles.reply}>{conversationId ? "Continuing a saved conversation with durable context." : "Start a new conversation or reopen a saved one."}</Text>
          <View style={styles.actions}>
            <Pressable style={styles.primary} onPress={startNewConversation} disabled={busy || loadingConversation}><Text style={styles.primaryText}>NEW CHAT</Text></Pressable>
            <Pressable style={styles.secondary} onPress={() => void refreshConversations()} disabled={busy || loadingConversation}><Text style={styles.secondaryText}>{loadingConversation ? "LOADING" : "REFRESH"}</Text></Pressable>
          </View>
          {conversationError ? <Text style={styles.warning}>{conversationError}</Text> : null}
          {conversations.length ? conversations.slice(0, 8).map((item) => (
            <Pressable key={item.id} style={item.id === conversationId ? styles.activeConversation : styles.conversation} onPress={() => void openConversation(item.id)} disabled={busy || loadingConversation}>
              <Text style={styles.device}>{conversationLabel(item)}</Text>
              <Text style={styles.muted}>{item.id === conversationId ? "CURRENT CONVERSATION" : new Date(item.updatedAt).toLocaleString()}</Text>
            </Pressable>
          )) : <Text style={styles.muted}>Your saved chats will appear here after the first reply.</Text>}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Ask FROSH</Text>
          <Text style={styles.reply}>{reply}</Text>
          {conversationMessages.length ? (
            <View style={styles.chatHistory}>
              {conversationMessages.slice(-30).map((item) => (
                <View key={item.id} style={item.role === "user" ? styles.userTurn : styles.assistantTurn}>
                  <Text style={styles.turnLabel}>{item.role === "user" ? "YOU" : "FROSH"}</Text>
                  <Text style={styles.reply}>{item.content}</Text>
                </View>
              ))}
            </View>
          ) : null}
          <TextInput
            value={message}
            onChangeText={setMessage}
            placeholder="What do you want FROSH to do?"
            placeholderTextColor="#6b7280"
            multiline
            style={styles.input}
          />
          <Text style={listening ? styles.aiReady : styles.muted}>{listening ? "VOICE INPUT ACTIVE · speak your command" : `VOICE INPUT · ${voiceInputStatus}`}</Text>
          <Text style={styles.muted}>Audio goes to the Android speech service for transcription. FROSH receives the resulting text only, then sends it as one command.</Text>
          <View style={styles.actions}>
            <Pressable style={styles.primary} onPress={ask} disabled={busy || listening}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>ASK</Text>}
            </Pressable>
            <Pressable style={styles.secondary} onPress={listening ? () => stopVoiceInput() : startVoiceInput} disabled={busy}>
              <Text style={styles.secondaryText}>{listening ? "STOP VOICE" : "VOICE"}</Text>
            </Pressable>
          </View>
          {listening ? <Pressable style={styles.secondary} onPress={() => stopVoiceInput(true)}><Text style={styles.secondaryText}>CANCEL VOICE</Text></Pressable> : null}
          <Pressable style={styles.secondary} onPress={startTask} disabled={busy || listening}>
            <Text style={styles.secondaryText}>START TASK</Text>
          </Pressable>
        </View>

        {approval ? (
          <View style={styles.approvalCard}>
            <Text style={styles.cardTitle}>Approval Required</Text>
            <Text style={styles.reply}>{approval.reason}</Text>
            <Text style={styles.muted}>Action: {approval.toolName}</Text>
            <View style={styles.actions}>
              <Pressable style={styles.primary} onPress={async () => { const result = await resolveApproval(approval.id, "approved"); setRun(result.run); setApproval(null); }}><Text style={styles.primaryText}>APPROVE</Text></Pressable>
              <Pressable style={styles.secondary} onPress={async () => { const result = await resolveApproval(approval.id, "rejected"); setRun(result.run); setApproval(null); }}><Text style={styles.secondaryText}>REJECT</Text></Pressable>
            </View>
          </View>
        ) : null}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Current Task</Text>
          <Text style={styles.reply}>
            {run ? `${run.status.toUpperCase()} • ${run.goal}` : "No active agent run."}
          </Text>
          {run?.pendingApprovalId ? (
            <Text style={styles.warning}>Approval required: {run.pendingApprovalId}</Text>
          ) : null}
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Connected Devices</Text>
          {devices.length ? devices.map((device) => (
            <Text key={device.id} style={styles.device}>
              {device.platform.toUpperCase()} • {device.name} • {device.status.toUpperCase()}
            </Text>
          )) : <Text style={styles.muted}>No devices connected yet.</Text>}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#07110b" },
  container: { padding: 22, gap: 16 },
  eyebrow: { color: "#6ee7b7", fontSize: 11, fontWeight: "800", letterSpacing: 2 },
  title: { color: "#f0fdf4", fontSize: 48, fontWeight: "900", letterSpacing: 4 },
  status: { color: "#4ade80", fontWeight: "800" },
  aiReady: { color: "#6ee7b7", fontSize: 12, fontWeight: "800", letterSpacing: 0.6 },
  aiSetup: { color: "#fbbf24", fontSize: 12, fontWeight: "800", letterSpacing: 0.6 },
  approvalCard: { backgroundColor: "#211a08", borderWidth: 1, borderColor: "#854d0e", borderRadius: 18, padding: 18, gap: 12 },
  card: { backgroundColor: "#0d1b13", borderWidth: 1, borderColor: "#173524", borderRadius: 18, padding: 18, gap: 12 },
  cardTitle: { color: "#dcfce7", fontSize: 17, fontWeight: "800" },
  reply: { color: "#d1d5db", fontSize: 15, lineHeight: 22 },
  replyRow: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 10 },
  inputSingle: { minHeight: 48, backgroundColor: "#07110b", borderRadius: 12, padding: 14, color: "#fff" },
  input: { minHeight: 90, backgroundColor: "#07110b", borderRadius: 12, padding: 14, color: "#fff", textAlignVertical: "top" },
  camera: { height: 320, borderRadius: 12, overflow: "hidden", backgroundColor: "#07110b" },
  actions: { flexDirection: "row", gap: 10 },
  primary: { flex: 1, minHeight: 48, borderRadius: 12, backgroundColor: "#16a34a", alignItems: "center", justifyContent: "center" },
  primaryText: { color: "#fff", fontWeight: "900" },
  secondary: { flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: "#166534", alignItems: "center", justifyContent: "center" },
  secondaryText: { color: "#86efac", fontWeight: "900" },
  warning: { color: "#fbbf24" },
  device: { color: "#d1d5db", paddingVertical: 4 },
  notification: { borderTopWidth: 1, borderTopColor: "#173524", paddingTop: 10, gap: 3 },
  conversation: { borderTopWidth: 1, borderTopColor: "#173524", paddingTop: 10, gap: 3 },
  activeConversation: { borderTopWidth: 1, borderTopColor: "#4ade80", paddingTop: 10, gap: 3 },
  chatHistory: { gap: 8, maxHeight: 500 },
  userTurn: { backgroundColor: "#123d27", borderRadius: 12, padding: 10, gap: 4 },
  assistantTurn: { backgroundColor: "#07110b", borderRadius: 12, padding: 10, gap: 4 },
  turnLabel: { color: "#86efac", fontSize: 11, fontWeight: "900", letterSpacing: 0.8 },
  muted: { color: "#6b7280" },
});
