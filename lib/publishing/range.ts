/** A single HTTP byte range against a file of `size` bytes, or null when no Range header was sent. */
export function parseRange(
  header: string | null,
  size: number
): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";

  let start: number;
  let end: number;
  if (match[1] === "") {
    // suffix range: the last N bytes
    const length = Number(match[2]);
    if (length === 0) return "invalid";
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start > end || start >= size) return "invalid";
  return { start, end };
}
