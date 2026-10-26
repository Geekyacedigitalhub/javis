// Render free instances can take more than 50 seconds to wake after inactivity.
// Keep this finite so an unavailable API does not leave the Control Center
// waiting forever, but allow the first Google-status request to wake it.
export const GOOGLE_UPSTREAM_TIMEOUT_MS = 75_000;
export const GOOGLE_COLD_START_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 24_000] as const;

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

export function isJsonResponse(response: Response): boolean {
  return (response.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
}

async function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("Google API request timed out.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Google API request timed out."));
    };
    function finish() {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Render's public edge can return a short HTML 502 while a free API instance
 * wakes. Retrying only that response lets the page recover without concealing
 * an API JSON error (such as authentication or configuration failures).
 */
export async function fetchGoogleUpstream(
  target: URL,
  init: RequestInit,
  signal: AbortSignal,
  fetcher: FetchLike = fetch,
  retryDelays: readonly number[] = GOOGLE_COLD_START_RETRY_DELAYS_MS,
): Promise<Response> {
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    let response: Response;
    try {
      response = await fetcher(target, { ...init, signal });
    } catch (error) {
      if (signal.aborted || attempt === retryDelays.length) throw error;
      await waitForRetry(retryDelays[attempt], signal);
      continue;
    }

    const retryableGatewayResponse = response.status >= 500 && !isJsonResponse(response);
    if (!retryableGatewayResponse || attempt === retryDelays.length) return response;

    // Release the small Render error document before the next attempt.
    void response.body?.cancel().catch(() => undefined);
    await waitForRetry(retryDelays[attempt], signal);
  }

  throw new Error("Google API request retry loop unexpectedly completed.");
}
