import { requireNativeModule } from "expo-modules-core";

export interface FroshInstalledApp {
  packageName: string;
  name: string;
}

type NativeApps = {
  listApps(): FroshInstalledApp[];
  openApp(packageName: string): { accepted: boolean; message: string; packageName?: string };
};

const native = requireNativeModule<NativeApps>("FroshApps");

export function listInstalledApps() {
  return native.listApps();
}

export function launchApp(packageName: string) {
  return native.openApp(packageName);
}
