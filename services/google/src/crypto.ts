const TOKEN_CIPHER_VERSION = 1;
const AAD = new TextEncoder().encode("frosh-google-integration-v1");

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length > 256) {
    throw new Error("Google integration encryption key is not valid base64.");
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function tokenEncryptionKeyFromEnvironment(value = process.env.FROSH_GOOGLE_TOKEN_ENCRYPTION_KEY): Uint8Array {
  const configured = value?.trim() ?? "";
  if (!configured) {
    throw new Error("Google integration is not configured: FROSH_GOOGLE_TOKEN_ENCRYPTION_KEY is required.");
  }
  const key = fromBase64(configured);
  if (key.byteLength !== 32) {
    throw new Error("FROSH_GOOGLE_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }
  return key;
}

function arrayBufferCopy(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", arrayBufferCopy(raw), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypts OAuth material before it ever reaches a persistence implementation. */
export async function encryptGoogleSecret(value: string, key: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: AAD },
    await importKey(key),
    new TextEncoder().encode(value),
  );
  return JSON.stringify({
    v: TOKEN_CIPHER_VERSION,
    iv: base64Url(iv),
    data: base64Url(new Uint8Array(encrypted)),
  });
}

export async function decryptGoogleSecret(payload: string, key: Uint8Array): Promise<string> {
  let parsed: { v?: unknown; iv?: unknown; data?: unknown };
  try {
    parsed = JSON.parse(payload) as { v?: unknown; iv?: unknown; data?: unknown };
  } catch {
    throw new Error("Stored Google credentials are unreadable.");
  }
  if (
    parsed.v !== TOKEN_CIPHER_VERSION ||
    typeof parsed.iv !== "string" ||
    typeof parsed.data !== "string" ||
    parsed.iv.length > 64 ||
    parsed.data.length > 32_000
  ) {
    throw new Error("Stored Google credentials are unreadable.");
  }

  try {
    const clear = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: arrayBufferCopy(fromBase64(parsed.iv)), additionalData: AAD },
      await importKey(key),
      arrayBufferCopy(fromBase64(parsed.data)),
    );
    return new TextDecoder().decode(clear);
  } catch {
    throw new Error("Stored Google credentials are unreadable.");
  }
}

export function randomOpaqueToken(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return base64Url(value);
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return base64Url(new Uint8Array(digest));
}
