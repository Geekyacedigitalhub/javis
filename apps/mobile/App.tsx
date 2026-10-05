import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import type { FroshDevice } from "../../packages/types/src/device";
import type { FroshAgentRun } from "../../packages/types/src/agent-run";
import { hasDeviceCredential, listDevices, registerDevice, resolveApproval, sendMessage, setDeviceCredential, startAgentRun } from "./src/api";
import { connectFroshRealtime } from "./src/realtime";
import type { FroshApprovalRequest } from "../../packages/types/src/approval";
import { loadDeviceCredential, saveDeviceCredential } from "./src/session";
import { runNativePhoneAction } from "./src/native-bridge";
import { controlMedia, readMediaState } from "./src/media-bridge";
import { getMediaState, openMediaAccessSettings } from "./src/media";
import { getNotificationCapability, getRecentNotifications, openNotificationSettings, replyToNotification } from "./modules/frosh-notifications/src";

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
  const [phoneNumber, setPhoneNumber] = useState("");
  const [mediaMessage, setMediaMessage] = useState("Media controls unavailable until Android MediaSession access is connected.");
  const [notifications, setNotifications] = useState<Array<{ id: string; packageName: string; title?: string; text?: string }>>([]);
  const [notificationAccess, setNotificationAccess] = useState("checking");
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState("");

  useEffect(() => {
    try {
      const capability = getNotificationCapability();
      setNotificationAccess(capability.available ? "active" : "permission required");
      if (capability.available) getRecentNotifications().then(setNotifications).catch(() => undefined);
    } catch {
      setNotificationAccess("native module unavailable");
    }

    loadDeviceCredential().then((saved) => {
      if (!saved) return;
      setDeviceCredential(saved);
      setPaired(true);
      listDevices().then((result) => setDevices(result.devices)).catch(() => undefined);
    });
  }, []);

  useEffect(() => {
    if (!paired) return;
    return connectFroshRealtime((event) => {
      if (event.type === "run.updated") setRun(event.run);
      if (event.type === "approval.created") setApproval(event.approval);
    }, setRealtimeStatus);
  }, [paired]);

  async function pairPhone() {
    setPairing(true);
    try {
      const device = await registerDevice(deviceName.trim() || "My Android Phone", [
        "chat",
        "agent-runs",
        "approvals",
        "realtime",
      ]);
      const result = await (await fetch(`${process.env.EXPO_PUBLIC_FROSH_API_URL ?? "http://localhost:3001"}/v1/devices/${device.id}`, {
        headers: { "x-frosh-device-id": device.id },
      })).json().catch(() => null);
      void result;
      setPaired(true);
      const saved = await loadDeviceCredential();
      if (saved) await saveDeviceCredential(saved);
      setDevices([device]);
    } catch (error) {
      setReply(error instanceof Error ? error.message : "Pairing failed.");
    } finally {
      setPairing(false);
    }
  }

  async function ask() {
    const value = message.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const result = await sendMessage(value);
      setReply(result.message);
      setMessage("");
    } catch (error) {
      setReply(error instanceof Error ? error.message : "FROSH request failed.");
    } finally {
      setBusy(false);
    }
  }

  async function startTask() {
    const value = message.trim();
    if (!value || busy) return;
    setBusy(true);
    try {
      const result = await startAgentRun(value);
      setRun(result);
      setMessage("");
      setReply(result.result ?? "FROSH started the task.");
    } catch (error) {
      setReply(error instanceof Error ? error.message : "Could not start task.");
    } finally {
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
            <Pressable style={styles.primary} onPress={pairPhone} disabled={pairing}>
              {pairing ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>PAIR PHONE</Text>}
            </Pressable>
          </View>
        ) : null}
        <Text style={styles.eyebrow}>PERSONAL AI OPERATING SYSTEM</Text>
        <Text style={styles.title}>FROSH</Text>
        <Text style={styles.status}>● {realtimeStatus === "open" ? "LIVE" : realtimeStatus.toUpperCase()}</Text>

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
          <Text style={styles.cardTitle}>Ask FROSH</Text>
          <Text style={styles.reply}>{reply}</Text>
          <TextInput
            value={message}
            onChangeText={setMessage}
            placeholder="What do you want FROSH to do?"
            placeholderTextColor="#6b7280"
            multiline
            style={styles.input}
          />
          <View style={styles.actions}>
            <Pressable style={styles.primary} onPress={ask} disabled={busy}>
              {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>ASK</Text>}
            </Pressable>
            <Pressable style={styles.secondary} onPress={startTask} disabled={busy}>
              <Text style={styles.secondaryText}>START TASK</Text>
            </Pressable>
          </View>
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
  approvalCard: { backgroundColor: "#211a08", borderWidth: 1, borderColor: "#854d0e", borderRadius: 18, padding: 18, gap: 12 },
  card: { backgroundColor: "#0d1b13", borderWidth: 1, borderColor: "#173524", borderRadius: 18, padding: 18, gap: 12 },
  cardTitle: { color: "#dcfce7", fontSize: 17, fontWeight: "800" },
  reply: { color: "#d1d5db", fontSize: 15, lineHeight: 22 },
  inputSingle: { minHeight: 48, backgroundColor: "#07110b", borderRadius: 12, padding: 14, color: "#fff" },
  input: { minHeight: 90, backgroundColor: "#07110b", borderRadius: 12, padding: 14, color: "#fff", textAlignVertical: "top" },
  actions: { flexDirection: "row", gap: 10 },
  primary: { flex: 1, minHeight: 48, borderRadius: 12, backgroundColor: "#16a34a", alignItems: "center", justifyContent: "center" },
  primaryText: { color: "#fff", fontWeight: "900" },
  secondary: { flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: "#166534", alignItems: "center", justifyContent: "center" },
  secondaryText: { color: "#86efac", fontWeight: "900" },
  warning: { color: "#fbbf24" },
  device: { color: "#d1d5db", paddingVertical: 4 },
  notification: { borderTopWidth: 1, borderTopColor: "#173524", paddingTop: 10, gap: 3 },
  muted: { color: "#6b7280" },
});
