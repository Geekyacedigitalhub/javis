import type { FroshToolExecutionContext } from "../../../packages/types/src/javis";
import type {
  FroshAutonomyLevel,
  FroshMode,
  FroshNotificationStyle,
  FroshPersonality,
  FroshResponseLength,
  FroshTechnicalDepth,
  FroshUserPreferences,
} from "../../../packages/types/src/preferences";
import { getUserPreferenceStore } from "../../preferences/src/factory";
import { registerTool } from "./registry";

const MODES: readonly FroshMode[] = ["normal", "focus", "coding", "research", "voice", "quiet", "autonomous"];
const PERSONALITIES: readonly FroshPersonality[] = ["helpful", "direct", "warm", "formal"];
const RESPONSE_LENGTHS: readonly FroshResponseLength[] = ["short", "balanced", "detailed"];
const TECHNICAL_DEPTHS: readonly FroshTechnicalDepth[] = ["plain", "adaptive", "expert"];
const AUTONOMY_LEVELS: readonly FroshAutonomyLevel[] = ["confirm", "safe", "trusted"];
const NOTIFICATION_STYLES: readonly FroshNotificationStyle[] = ["all", "important", "quiet"];

function owner(context?: FroshToolExecutionContext): string {
  const userId = context?.userId?.trim();
  if (!userId) throw new Error("Preferences are available only in an authenticated FROSH session.");
  return userId;
}

function object(args: Record<string, unknown>): string | null {
  return args && typeof args === "object" && !Array.isArray(args) ? null : "Arguments must be an object.";
}

function enumError(value: unknown, label: string, values: readonly string[]): string | null {
  if (value === undefined) return null;
  return typeof value === "string" && values.includes(value) ? null : `${label} is invalid.`;
}

function voiceLanguageError(value: unknown): string | null {
  if (value === undefined) return null;
  const language = typeof value === "string" ? value.trim() : "";
  return /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language) ? null : "voiceLanguage must be a BCP-47 language tag.";
}

function preferencesSummary(preferences: FroshUserPreferences) {
  return {
    mode: preferences.mode,
    personality: preferences.personality,
    responseLength: preferences.responseLength,
    technicalDepth: preferences.technicalDepth,
    autonomyLevel: preferences.autonomyLevel,
    notificationStyle: preferences.notificationStyle,
    voiceLanguage: preferences.voiceLanguage,
    updatedAt: preferences.updatedAt,
  };
}

function updateError(args: Record<string, unknown>): string | null {
  if (object(args)) return "Arguments must be an object.";
  const fields = ["mode", "personality", "responseLength", "technicalDepth", "autonomyLevel", "notificationStyle", "voiceLanguage"];
  if (!fields.some((field) => Object.hasOwn(args, field))) return "Provide at least one preference to update.";
  return enumError(args.mode, "mode", MODES)
    ?? enumError(args.personality, "personality", PERSONALITIES)
    ?? enumError(args.responseLength, "responseLength", RESPONSE_LENGTHS)
    ?? enumError(args.technicalDepth, "technicalDepth", TECHNICAL_DEPTHS)
    ?? enumError(args.autonomyLevel, "autonomyLevel", AUTONOMY_LEVELS)
    ?? enumError(args.notificationStyle, "notificationStyle", NOTIFICATION_STYLES)
    ?? voiceLanguageError(args.voiceLanguage);
}

registerTool({
  name: "read_my_preferences",
  description: "Read the FROSH operating preferences for the authenticated user. These guide response style but never weaken safety rules or approval requirements.",
  permission: "safe",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  validate: object,
  async execute(_args, context) {
    return { preferences: preferencesSummary(await getUserPreferenceStore().get(owner(context))) };
  },
});

registerTool({
  name: "update_my_preferences",
  description: "Update durable FROSH operating preferences for the authenticated user. This changes future assistant behavior and requires explicit approval; it cannot weaken safety rules or approval requirements.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      mode: { type: "string", enum: [...MODES] },
      personality: { type: "string", enum: [...PERSONALITIES] },
      responseLength: { type: "string", enum: [...RESPONSE_LENGTHS] },
      technicalDepth: { type: "string", enum: [...TECHNICAL_DEPTHS] },
      autonomyLevel: { type: "string", enum: [...AUTONOMY_LEVELS] },
      notificationStyle: { type: "string", enum: [...NOTIFICATION_STYLES] },
      voiceLanguage: { type: "string", description: "BCP-47 language tag, such as en-NG." },
    },
    additionalProperties: false,
  },
  validate: updateError,
  async execute(args, context) {
    const patch: Partial<Omit<FroshUserPreferences, "userId" | "updatedAt">> = {};
    if (Object.hasOwn(args, "mode")) patch.mode = args.mode as FroshMode;
    if (Object.hasOwn(args, "personality")) patch.personality = args.personality as FroshPersonality;
    if (Object.hasOwn(args, "responseLength")) patch.responseLength = args.responseLength as FroshResponseLength;
    if (Object.hasOwn(args, "technicalDepth")) patch.technicalDepth = args.technicalDepth as FroshTechnicalDepth;
    if (Object.hasOwn(args, "autonomyLevel")) patch.autonomyLevel = args.autonomyLevel as FroshAutonomyLevel;
    if (Object.hasOwn(args, "notificationStyle")) patch.notificationStyle = args.notificationStyle as FroshNotificationStyle;
    if (Object.hasOwn(args, "voiceLanguage")) patch.voiceLanguage = (args.voiceLanguage as string).trim();
    return { preferences: preferencesSummary(await getUserPreferenceStore().update(owner(context), patch)) };
  },
});
