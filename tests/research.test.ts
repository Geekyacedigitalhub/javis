import { describe, expect, test } from "bun:test";
import { ResearchRequestError, validateResearchUrl } from "../services/research/src/fetch";

describe("research URL safety", () => {
  test("accepts a normal public HTTPS URL before it is fetched", () => {
    const url = validateResearchUrl("https://example.com/articles/frosh?topic=ai");
    expect(url.hostname).toBe("example.com");
    expect(url.protocol).toBe("https:");
  });

  for (const [label, value] of [
    ["plain HTTP", "http://example.com"],
    ["credentials", "https://user:password@example.com"],
    ["localhost", "https://localhost/admin"],
    ["loopback IPv4", "https://127.0.0.1/private"],
    ["private IPv4", "https://192.168.1.10/"],
    ["link-local IPv4", "https://169.254.169.254/latest/meta-data"],
    ["loopback IPv6", "https://[::1]/"],
    ["custom port", "https://example.com:8443/"],
  ]) {
    test(`refuses ${label}`, () => {
      expect(() => validateResearchUrl(value)).toThrow(ResearchRequestError);
    });
  }
});
