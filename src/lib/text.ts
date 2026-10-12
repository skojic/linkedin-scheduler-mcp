import { createHash } from "node:crypto";

// Reserved characters in LinkedIn's "little" text format. Every one must be
// backslash-escaped to be treated as plain text, even outside mentions and
// hashtags. Source: Microsoft Learn, "little Text Format" (li-lms-2026-09).
const RESERVED = /[|{}@\[\]()<>#\\*_~]/g;

export function escapeLittleText(text: string): string {
  return text.replace(RESERVED, (ch) => `\\${ch}`);
}

// Conservative count against the 3,000 cap. LinkedIn's own counting is not
// documented, so this never counts lower than either plausible method:
// pictographs and astral code points count 2, everything else (including
// variation selectors) counts 1, and the result is at least the UTF-16 length.
const PICTO = /\p{Extended_Pictographic}/u;
export function charCount(text: string): number {
  let n = 0;
  for (const ch of text) n += PICTO.test(ch) || ch.codePointAt(0)! > 0xffff ? 2 : 1;
  return Math.max(n, text.length);
}

export const MAX_CHARS = 3000;

export function contentHash(body: string, image: Uint8Array): string {
  const h = createHash("sha256");
  h.update(body, "utf8");
  h.update("\n--image--\n", "utf8");
  h.update(image);
  return h.digest("hex");
}
