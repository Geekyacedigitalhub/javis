import { requireNativeModule } from "expo-modules-core";

export interface FroshInstalledApp {
  packageName: string;
  name: string;
}

type NativeApps = {
  listApps(): FroshInstalledApp[];
  openApp(packageName: string): { accepted: boolean; message: string; packageName?: string };
  listMessagingApps(): Array<{ provider: string; packageName: string; name: string }>;
};

const native = requireNativeModule<NativeApps>("FroshApps");

export function listInstalledApps() {
  return native.listApps();
}

export function launchApp(packageName: string) {
  return native.openApp(packageName);
}

export function resolveInstalledApp(query: string) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;
  const apps = listInstalledApps();
  const exact = apps.find((app) =>
    app.name.toLowerCase() === normalized ||
    app.packageName.toLowerCase() === normalized
  );
  if (exact) return exact;
  const matches = apps.filter((app) =>
    app.name.toLowerCase().includes(normalized) ||
    normalized.includes(app.name.toLowerCase()) ||
    app.packageName.toLowerCase().includes(normalized)
  );
  return matches.length === 1 ? matches[0] : null;
}

export function launchAppByName(query: string) {
  const app = resolveInstalledApp(query);
  if (!app) {
    return { accepted: false, message: "I couldn't uniquely identify an installed app with that name." };
  }
  return native.openApp(app.packageName);
}

export function listInstalledMessagingApps() {
  return native.listMessagingApps();
}
