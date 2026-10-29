/** Split a text/event-stream buffer without assuming network chunks align with
 * SSE events. The returned remainder must be kept for the next read. */
export function takeSseFrames(buffer: string) {
  const frames: string[] = [];
  let remainder = buffer;
  let match = remainder.match(/\r?\n\r?\n/);
  while (match?.index !== undefined) {
    frames.push(remainder.slice(0, match.index));
    remainder = remainder.slice(match.index + match[0].length);
    match = remainder.match(/\r?\n\r?\n/);
  }
  return { frames, remainder };
}

/** Extract an SSE data payload. SSE permits repeated data lines, which join
 * with newlines. Empty keep-alive frames and the conventional [DONE] marker
 * do not represent application events. */
export function sseData(frame: string): string | null {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  return data && data !== "[DONE]" ? data : null;
}
