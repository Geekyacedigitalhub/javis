// A single Render request must finish before the public edge gives up and
// substitutes its own HTML 502. The browser retries independent, short status
// requests while a free API instance wakes, rather than holding one proxy
// request open through the whole cold-start window.
export const GOOGLE_UPSTREAM_TIMEOUT_MS = 15_000;
export const GOOGLE_COLD_START_RETRY_DELAYS_MS = [1_000] as const;

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
 * wakes. Make one quick retry here; the integrations page performs the longer
 * cold-start retry sequence as separate requests, so this route stays below
 * the edge timeout and can always return JSON.
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
