import React, { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import type { FroshDevice } from "../../packages/types/src/device";
import type { FroshAgentRun } from "../../packages/types/src/agent-run";
import { listDevices, sendMessage, startAgentRun } from "./src/api";

export default function App() {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("FROSH is ready.");
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<FroshDevice[]>([]);
  const [run, setRun] = useState<FroshAgentRun | null>(null);

  useEffect(() => {
    listDevices().then((result) => setDevices(result.devices)).catch(() => undefined);
  }, []);

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
        <Text style={styles.eyebrow}>PERSONAL AI OPERATING SYSTEM</Text>
        <Text style={styles.title}>FROSH</Text>
        <Text style={styles.status}>● ONLINE</Text>

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
  card: { backgroundColor: "#0d1b13", borderWidth: 1, borderColor: "#173524", borderRadius: 18, padding: 18, gap: 12 },
  cardTitle: { color: "#dcfce7", fontSize: 17, fontWeight: "800" },
  reply: { color: "#d1d5db", fontSize: 15, lineHeight: 22 },
  input: { minHeight: 90, backgroundColor: "#07110b", borderRadius: 12, padding: 14, color: "#fff", textAlignVertical: "top" },
  actions: { flexDirection: "row", gap: 10 },
  primary: { flex: 1, minHeight: 48, borderRadius: 12, backgroundColor: "#16a34a", alignItems: "center", justifyContent: "center" },
  primaryText: { color: "#fff", fontWeight: "900" },
  secondary: { flex: 1, minHeight: 48, borderRadius: 12, borderWidth: 1, borderColor: "#166534", alignItems: "center", justifyContent: "center" },
  secondaryText: { color: "#86efac", fontWeight: "900" },
  warning: { color: "#fbbf24" },
  device: { color: "#d1d5db", paddingVertical: 4 },
  muted: { color: "#6b7280" },
});
