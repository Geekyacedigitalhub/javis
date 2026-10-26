export type FroshMode = "normal" | "focus" | "coding" | "research" | "voice" | "quiet" | "autonomous";
export type FroshResponseLength = "short" | "balanced" | "detailed";
export type FroshTechnicalDepth = "plain" | "adaptive" | "expert";
export type FroshAutonomyLevel = "confirm" | "safe" | "trusted";
export type FroshNotificationStyle = "all" | "important" | "quiet";
export type FroshPersonality = "helpful" | "direct" | "warm" | "formal";

export interface FroshUserPreferences {
  userId: string;
  mode: FroshMode;
  personality: FroshPersonality;
  responseLength: FroshResponseLength;
  technicalDepth: FroshTechnicalDepth;
  autonomyLevel: FroshAutonomyLevel;
  notificationStyle: FroshNotificationStyle;
  voiceLanguage: string;
  updatedAt: string;
}

export interface FroshUserPreferenceStore {
  get(userId: string): Promise<FroshUserPreferences>;
  update(userId: string, patch: Partial<Omit<FroshUserPreferences, "userId" | "updatedAt">>): Promise<FroshUserPreferences>;
}
