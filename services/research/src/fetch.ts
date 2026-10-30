import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_EXTRACTED_CHARS = 16_000;
const REQUEST_TIMEOUT_MS = 12_000;

export type FroshResearchSource = {
  requestedUrl: string;
  url: string;
  host: string;
  title?: string;
  description?: string;
  contentType: string;
  excerpt: string;
  text: string;
  fetchedAt: string;
};

export class ResearchRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchRequestError";
  }
}

function configuredHosts(): string[] {
  return (process.env.FROSH_RESEARCH_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [first, second] = address.split(".").map(Number);
    return first === 0 || first === 10 || first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224;
  }

  if (version === 6) {
    const normalized = address.toLowerCase();
    return normalized === "::1" || normalized === "::" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") ||
      normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb") ||
      normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.") || normalized.startsWith("::ffff:169.254.");
  }

  return true;
}

/** Validate URL shape before a connection is attempted. */
export function validateResearchUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new ResearchRequestError("A valid HTTPS URL is required.");
  }

  if (url.protocol !== "https:") {
    throw new ResearchRequestError("Research only supports HTTPS URLs.");
  }
  if (url.username || url.password) {
    throw new ResearchRequestError("Research URLs cannot contain credentials.");
  }
  if (url.port && url.port !== "443") {
    throw new ResearchRequestError("Research URLs must use the standard HTTPS port.");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new ResearchRequestError("Local network addresses cannot be researched.");
  }
  if (isIP(host) && isPrivateAddress(host)) {
    throw new ResearchRequestError("Private network addresses cannot be researched.");
  }
  return url;
}

async function assertPublicHost(url: URL, enforceResearchAllowlist = true): Promise<void> {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const allowlist = configuredHosts();
  if (enforceResearchAllowlist && allowlist.length && !allowlist.includes(host)) {
    throw new ResearchRequestError("This research host is not in FROSH_RESEARCH_ALLOWED_HOSTS.");
  }

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new ResearchRequestError("Private network addresses cannot be researched.");
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new ResearchRequestError("FROSH could not resolve that research host.");
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ResearchRequestError("The research host resolves to a private or unsafe address.");
  }
}

/** Internal shared guard for non-research public HTTPS egress such as monitors. */
export async function assertPublicProbeUrl(url: URL): Promise<void> {
  return assertPublicHost(url, false);
}

function decodeCodePoint(value: string, radix: number, original: string): string {
  const point = Number.parseInt(value, radix);
  return Number.isInteger(point) && point >= 0 && point <= 0x10ffff
    ? String.fromCodePoint(point)
    : original;
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (original, decimal: string) => decodeCodePoint(decimal, 10, original))
    .replace(/&#x([0-9a-f]+);/gi, (original, hex: string) => decodeCodePoint(hex, 16, original));
}

function normalizeText(value: string): string {
  return decodeHtml(value)
    .replace(/\r/g, "")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function attributeContent(tag: string, name: string): string | undefined {
  const expression = new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, "i");
  return tag.match(expression)?.[1];
}

function extractDocument(content: string, contentType: string): Pick<FroshResearchSource, "title" | "description" | "excerpt" | "text"> {
  if (!contentType.includes("html")) {
    const text = normalizeText(content).slice(0, MAX_EXTRACTED_CHARS);
    return { excerpt: text.slice(0, 500), text };
  }

  const title = content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const metaTags = content.match(/<meta\b[^>]*>/gi) ?? [];
  const descriptionTag = metaTags.find((tag) => /(?:name|property)\s*=\s*["'](?:description|og:description)["']/i.test(tag));
  const description = descriptionTag ? attributeContent(descriptionTag, "content") : undefined;
  const text = normalizeText(
    content
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|h[1-6]|article|section|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  ).slice(0, MAX_EXTRACTED_CHARS);

  return {
    title: title ? normalizeText(title) : undefined,
    description: description ? normalizeText(description) : undefined,
    excerpt: text.slice(0, 500),
    text,
  };
}

async function responseTextWithinLimit(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new ResearchRequestError("The research page is larger than FROSH's 1 MB safety limit.");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_RESPONSE_BYTES) {
    throw new ResearchRequestError("The research page is larger than FROSH's 1 MB safety limit.");
  }
  return new TextDecoder().decode(buffer);
}

/**
 * Fetch one public document for research. Redirects are checked one by one so
 * a public URL cannot bounce FROSH into a local network service.
 */
export async function fetchResearchSource(rawUrl: string): Promise<FroshResearchSource> {
  const requested = validateResearchUrl(rawUrl);
  let current = requested;

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    await assertPublicHost(current);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html, text/plain, application/xhtml+xml;q=0.9, application/json;q=0.5",
          "User-Agent": "FROSH-Research/0.1 (+https://github.com/Geekyacedigitalhub/javis)",
        },
      });
    } catch (error) {
      if (controller.signal.aborted) throw new ResearchRequestError("The research page did not respond in time.");
      throw new ResearchRequestError("FROSH could not fetch that research page.");
    } finally {
      clearTimeout(timeout);
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new ResearchRequestError("The research page redirected without a destination.");
      if (redirect === MAX_REDIRECTS) throw new ResearchRequestError("The research page redirected too many times.");
      current = validateResearchUrl(new URL(location, current).toString());
      continue;
    }

    if (!response.ok) throw new ResearchRequestError(`The research page responded with HTTP ${response.status}.`);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "text/plain";
    if (!/(?:text\/html|text\/plain|application\/xhtml\+xml|application\/json)/.test(contentType)) {
      throw new ResearchRequestError("FROSH can only extract text, HTML, or JSON research pages.");
    }
    const content = await responseTextWithinLimit(response);
    const document = extractDocument(content, contentType);
    return {
      requestedUrl: requested.toString(),
      url: current.toString(),
      host: current.hostname,
      contentType,
      ...document,
      fetchedAt: new Date().toISOString(),
    };
  }

  throw new ResearchRequestError("FROSH could not follow the research URL.");
}
