import { requireNativeModule } from "expo-modules-core";

type NativeMedia = {
  getPermissionStatus(): string;
  getState(): Promise<Record<string, unknown>>;
  control(action: string): Promise<{ accepted: boolean; message: string }>;
  volume(direction: "up" | "down"): Promise<{ accepted: boolean; message: string }>;
};

export default requireNativeModule<NativeMedia>("FroshMedia");
