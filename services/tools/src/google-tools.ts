import { getGoogleIntegrationStore } from "../../google/src";
import { GoogleIntegrationService } from "../../google/src/service";
import { registerTool } from "./registry";

function userId(): string {
  return process.env.FROSH_USER_ID?.trim() || "default-user";
}

function google(): GoogleIntegrationService {
  return new GoogleIntegrationService(getGoogleIntegrationStore());
}

function asObject(value: Record<string, unknown>): string | null {
  return value && typeof value === "object" && !Array.isArray(value) ? null : "Arguments must be an object.";
}

registerTool({
  name: "google_gmail_list_unread",
  description: "List recent unread Gmail message metadata (sender, subject, date, and snippet) from the connected Google account. Never sends, deletes, or modifies mail.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 25 } },
    additionalProperties: false,
  },
  validate(args) {
    if (asObject(args)) return "Arguments must be an object.";
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 25)) {
      return "limit must be an integer between 1 and 25.";
    }
    return null;
  },
  async execute(args) {
    return { messages: await google().listUnreadGmail(userId(), args.limit as number | undefined) };
  },
});

registerTool({
  name: "google_calendar_list_events",
  description: "List upcoming events from the connected Google Calendar. This only reads event information and does not change the calendar.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: {
      from: { type: "string", description: "ISO date-time, optional" },
      to: { type: "string", description: "ISO date-time, optional" },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  },
  validate(args) {
    if (asObject(args)) return "Arguments must be an object.";
    if (args.from !== undefined && typeof args.from !== "string") return "from must be an ISO date-time.";
    if (args.to !== undefined && typeof args.to !== "string") return "to must be an ISO date-time.";
    if (args.limit !== undefined && (!Number.isInteger(args.limit) || (args.limit as number) < 1 || (args.limit as number) > 50)) {
      return "limit must be an integer between 1 and 50.";
    }
    return null;
  },
  async execute(args) {
    return { events: await google().listCalendarEvents(userId(), args) };
  },
});

registerTool({
  name: "google_calendar_create_event",
  description: "Create a Google Calendar event. This changes the connected calendar and always requires the user's explicit approval before FROSH performs it.",
  permission: "confirm",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string" },
      startAt: { type: "string", description: "ISO date-time" },
      endAt: { type: "string", description: "ISO date-time" },
      description: { type: "string" },
      location: { type: "string" },
    },
    required: ["summary", "startAt", "endAt"],
    additionalProperties: false,
  },
  validate(args) {
    if (asObject(args)) return "Arguments must be an object.";
    if (typeof args.summary !== "string" || !args.summary.trim()) return "summary is required.";
    if (typeof args.startAt !== "string" || !Number.isFinite(Date.parse(args.startAt))) return "startAt must be an ISO date-time.";
    if (typeof args.endAt !== "string" || !Number.isFinite(Date.parse(args.endAt))) return "endAt must be an ISO date-time.";
    if (Date.parse(args.endAt) <= Date.parse(args.startAt)) return "endAt must be after startAt.";
    if (args.description !== undefined && typeof args.description !== "string") return "description must be text.";
    if (args.location !== undefined && typeof args.location !== "string") return "location must be text.";
    return null;
  },
  async execute(args) {
    return { event: await google().createCalendarEvent(userId(), args) };
  },
});
