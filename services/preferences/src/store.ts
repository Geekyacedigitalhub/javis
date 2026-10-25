import postgres from "postgres";
import type {
  FroshAutonomyLevel,
  FroshMode,
  FroshNotificationStyle,
  FroshPersonality,
  FroshResponseLength,
  FroshTechnicalDepth,
  FroshUserPreferenceStore,
  FroshUserPreferences,
} from "../../../packages/types/src/preferences";

type Sql = ReturnType<typeof postgres>;
type PreferencePatch = Partial<Omit<FroshUserPreferences, "userId" | "updatedAt">>;

const modes: FroshMode[] = ["normal", "focus", "coding", "research", "voice", "quiet", "autonomous"];
const personalities: FroshPersonality[] = ["helpful", "direct", "warm", "formal"];
const responseLengths: FroshResponseLength[] = ["short", "balanced", "detailed"];
const technicalDepths: FroshTechnicalDepth[] = ["plain", "adaptive", "expert"];
const autonomyLevels: FroshAutonomyLevel[] = ["confirm", "safe", "trusted"];
const notificationStyles: FroshNotificationStyle[] = ["all", "important", "quiet"];

export const DEFAULT_PREFERENCES: Omit<FroshUserPreferences, "userId" | "updatedAt"> = {
  mode: "normal",
  personality: "helpful",
  responseLength: "balanced",
  technicalDepth: "adaptive",
  autonomyLevel: "confirm",
  notificationStyle: "important",
  voiceLanguage: "en-NG",
};

function validateUserId(userId: string): string {
  const value = typeof userId === "string" ? userId.trim() : "";
  if (!value || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("Invalid user ID");
  return value;
}

function validatePatch(patch: PreferencePatch): PreferencePatch {
  const next: PreferencePatch = {};
  if (Object.hasOwn(patch, "mode")) {
    if (!modes.includes(patch.mode!)) throw new Error("Invalid FROSH mode");
    next.mode = patch.mode;
  }
  if (Object.hasOwn(patch, "personality")) {
    if (!personalities.includes(patch.personality!)) throw new Error("Invalid personality");
    next.personality = patch.personality;
  }
  if (Object.hasOwn(patch, "responseLength")) {
    if (!responseLengths.includes(patch.responseLength!)) throw new Error("Invalid response length");
    next.responseLength = patch.responseLength;
  }
  if (Object.hasOwn(patch, "technicalDepth")) {
    if (!technicalDepths.includes(patch.technicalDepth!)) throw new Error("Invalid technical depth");
    next.technicalDepth = patch.technicalDepth;
  }
  if (Object.hasOwn(patch, "autonomyLevel")) {
    if (!autonomyLevels.includes(patch.autonomyLevel!)) throw new Error("Invalid autonomy level");
    next.autonomyLevel = patch.autonomyLevel;
  }
  if (Object.hasOwn(patch, "notificationStyle")) {
    if (!notificationStyles.includes(patch.notificationStyle!)) throw new Error("Invalid notification style");
    next.notificationStyle = patch.notificationStyle;
  }
  if (Object.hasOwn(patch, "voiceLanguage")) {
    const language = typeof patch.voiceLanguage === "string" ? patch.voiceLanguage.trim() : "";
    if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) throw new Error("voiceLanguage must be a BCP-47 language tag");
    next.voiceLanguage = language;
  }
  return next;
}

function defaultsFor(userId: string): FroshUserPreferences {
  return { userId, ...DEFAULT_PREFERENCES, updatedAt: new Date().toISOString() };
}

export class InMemoryUserPreferenceStore implements FroshUserPreferenceStore {
  private readonly items = new Map<string, FroshUserPreferences>();

  async get(userId: string) {
    const id = validateUserId(userId);
    const existing = this.items.get(id);
    if (existing) return existing;
    const initial = defaultsFor(id);
    this.items.set(id, initial);
    return initial;
  }

  async update(userId: string, patch: PreferencePatch) {
    const current = await this.get(userId);
    const next = { ...current, ...validatePatch(patch), updatedAt: new Date().toISOString() };
    this.items.set(current.userId, next);
    return next;
  }
}

export class PostgresUserPreferenceStore implements FroshUserPreferenceStore {
  constructor(private readonly sql: Sql) {}

  async close() { await this.sql.end({ timeout: 5 }); }

  async get(userId: string) {
    const id = validateUserId(userId);
    const rows = await this.sql.unsafe<FroshUserPreferences[]>(
      `INSERT INTO frosh_user_preferences(user_id,mode,personality,response_length,technical_depth,autonomy_level,notification_style,voice_language)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id) DO UPDATE SET user_id=EXCLUDED.user_id
       RETURNING user_id AS "userId",mode,personality,response_length AS "responseLength",technical_depth AS "technicalDepth",
       autonomy_level AS "autonomyLevel",notification_style AS "notificationStyle",voice_language AS "voiceLanguage",updated_at AS "updatedAt"`,
      [id, DEFAULT_PREFERENCES.mode, DEFAULT_PREFERENCES.personality, DEFAULT_PREFERENCES.responseLength,
        DEFAULT_PREFERENCES.technicalDepth, DEFAULT_PREFERENCES.autonomyLevel, DEFAULT_PREFERENCES.notificationStyle,
        DEFAULT_PREFERENCES.voiceLanguage],
    );
    return rows[0];
  }

  async update(userId: string, patch: PreferencePatch) {
    const current = await this.get(userId);
    const next = { ...current, ...validatePatch(patch) };
    const rows = await this.sql.unsafe<FroshUserPreferences[]>(
      `UPDATE frosh_user_preferences SET mode=$2,personality=$3,response_length=$4,technical_depth=$5,autonomy_level=$6,
       notification_style=$7,voice_language=$8,updated_at=NOW() WHERE user_id=$1
       RETURNING user_id AS "userId",mode,personality,response_length AS "responseLength",technical_depth AS "technicalDepth",
       autonomy_level AS "autonomyLevel",notification_style AS "notificationStyle",voice_language AS "voiceLanguage",updated_at AS "updatedAt"`,
      [current.userId, next.mode, next.personality, next.responseLength, next.technicalDepth, next.autonomyLevel, next.notificationStyle, next.voiceLanguage],
    );
    return rows[0];
  }
}
