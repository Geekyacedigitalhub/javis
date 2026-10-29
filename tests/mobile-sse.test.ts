import { expect, test } from "bun:test";
import { sseData, takeSseFrames } from "../apps/mobile/src/sse";

test("mobile SSE framing keeps an incomplete network chunk for the next read", () => {
  const first = takeSseFrames('data: {"type":"delta","text":"Hel"}\n\ndata: {"type":"delta"');
  expect(first.frames).toEqual(['data: {"type":"delta","text":"Hel"}']);
  expect(first.remainder).toBe('data: {"type":"delta"');

  const second = takeSseFrames(first.remainder + ',"text":"lo"}\r\n\r\n');
  expect(second.frames).toEqual(['data: {"type":"delta","text":"lo"}']);
  expect(second.remainder).toBe("");
});

test("mobile SSE payload handling supports repeated data lines and ignores keep-alives", () => {
  expect(sseData("event: message\ndata: first\ndata: second")).toBe("first\nsecond");
  expect(sseData(": heartbeat")).toBeNull();
  expect(sseData("data: [DONE]")).toBeNull();
});
