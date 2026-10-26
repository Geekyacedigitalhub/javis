import { fetchResearchSource, ResearchRequestError } from "../../research/src/fetch";
import { registerTool } from "./registry";

registerTool({
  name: "web_research_fetch",
  description: "Fetch and extract readable text from one public HTTPS research page. Read-only; private-network URLs are refused.",
  permission: "safe",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Public HTTPS URL to research." },
    },
    required: ["url"],
    additionalProperties: false,
  },
  validate(args) {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) return "A public HTTPS URL is required.";
    if (url.length > 2_000) return "The research URL is too long.";
    return null;
  },
  async execute(args) {
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) return { accepted: false, message: "A public HTTPS URL is required." };
    try {
      const source = await fetchResearchSource(url);
      return { accepted: true, source };
    } catch (error) {
      const message = error instanceof ResearchRequestError
        ? error.message
        : "FROSH could not retrieve that research page.";
      return { accepted: false, message };
    }
  },
});
