import { ResearchRequestError, validateResearchUrl } from "../../research/src/fetch";

const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 12_000;

export type FroshMonitorProbe = {
  health: "healthy" | "degraded" | "down";
  message: string;
  checkedAt: string;
  statusCode?: number;
  latencyMs: number;
  error?: string;
};

/**
 * Probe a public HTTPS endpoint without downloading its body. DNS safety and
 * redirect validation live beside research fetching so monitors cannot be used
 * as an SSRF path to FROSH's private network.
 */
export async function probeHttpMonitor(rawUrl: string): Promise<FroshMonitorProbe> {
  const { assertPublicProbeUrl } = await import("../../research/src/fetch");
  const started = Date.now();
  let current: URL;
  try {
    current = validateResearchUrl(rawUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : "A valid public HTTPS URL is required.";
    return { health: "down", message, checkedAt: new Date().toISOString(), latencyMs: 0, error: message };
  }

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const checkedAt = new Date().toISOString();
    try {
      await assertPublicProbeUrl(current);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(current, {
          method: "HEAD",
          redirect: "manual",
          signal: controller.signal,
          headers: { "User-Agent": "FROSH-Monitor/0.1 (+https://github.com/Geekyacedigitalhub/javis)" },
        });
      } finally {
        clearTimeout(timeout);
      }

      // HEAD is occasionally refused despite a healthy public endpoint. Retry
      // with a header-only GET; cancelling the body prevents monitor checks
      // from becoming a scraper or a bandwidth sink.
      if (response.status === 405 || response.status === 501) {
        response = await fetch(current, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { Range: "bytes=0-0", "User-Agent": "FROSH-Monitor/0.1 (+https://github.com/Geekyacedigitalhub/javis)" },
        });
      }
      void response.body?.cancel().catch(() => undefined);
      const latencyMs = Math.max(0, Date.now() - started);

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) return { health: "down", message: "Endpoint redirected without a destination.", checkedAt, statusCode: response.status, latencyMs, error: "Redirect without location" };
        if (redirect === MAX_REDIRECTS) return { health: "down", message: "Endpoint redirected too many times.", checkedAt, statusCode: response.status, latencyMs, error: "Too many redirects" };
        current = validateResearchUrl(new URL(location, current).toString());
        continue;
      }
      if (response.status >= 200 && response.status < 400) {
        return { health: "healthy", message: `Endpoint responded with HTTP ${response.status}.`, checkedAt, statusCode: response.status, latencyMs };
      }
      if (response.status >= 400 && response.status < 500) {
        return { health: "degraded", message: `Endpoint responded with HTTP ${response.status}.`, checkedAt, statusCode: response.status, latencyMs, error: `HTTP ${response.status}` };
      }
      return { health: "down", message: `Endpoint responded with HTTP ${response.status}.`, checkedAt, statusCode: response.status, latencyMs, error: `HTTP ${response.status}` };
    } catch (error) {
      const latencyMs = Math.max(0, Date.now() - started);
      const message = error instanceof ResearchRequestError
        ? error.message
        : error instanceof Error && /abort|timeout/i.test(error.name + " " + error.message)
          ? "Endpoint did not respond in time."
          : "FROSH could not reach the endpoint.";
      return { health: "down", message, checkedAt, latencyMs, error: message };
    }
  }

  return { health: "down", message: "FROSH could not check the endpoint.", checkedAt: new Date().toISOString(), latencyMs: Math.max(0, Date.now() - started), error: "Probe did not complete" };
}
