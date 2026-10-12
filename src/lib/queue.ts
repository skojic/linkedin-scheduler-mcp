import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Visibility = "PUBLIC" | "CONNECTIONS";

export interface PostMeta {
  id: string;
  publish_at: string; // local wall-clock "YYYY-MM-DD HH:mm"
  tz: string;
  publish_at_utc: string; // ISO
  window_minutes: number;
  visibility: Visibility;
  alt_text: string;
  image: string; // file name inside the queue folder
  source_path: string;
  content_hash: string;
  mode: "scheduled" | "now";
}

export type State = "scheduled" | "publishing" | "published" | "cancelled" | "expired" | "needs_attention";

export interface Status {
  state: State;
  updated_at: string;
  post_urn?: string;
  post_url?: string;
  run_id?: string;
  history: { state: State; at: string; note?: string }[];
}

const TRANSITIONS: Record<State, State[]> = {
  scheduled: ["scheduled", "publishing", "cancelled", "expired", "needs_attention"],
  publishing: ["published", "needs_attention"],
  published: [],
  cancelled: [],
  expired: [],
  needs_attention: [],
};

export function canTransition(from: State, to: State): boolean {
  return TRANSITIONS[from].includes(to);
}

export function transition(s: Status, to: State, note?: string, now: Date = new Date()): Status {
  if (!canTransition(s.state, to)) throw new Error(`illegal status change ${s.state} -> ${to}`);
  const at = now.toISOString();
  return { ...s, state: to, updated_at: at, history: [...s.history, { state: to, at, ...(note ? { note } : {}) }] };
}

export function newStatus(now: Date = new Date()): Status {
  const at = now.toISOString();
  return { state: "scheduled", updated_at: at, history: [{ state: "scheduled", at }] };
}

// post.md: "---\n" + one `key: <JSON>` line per field + "---\n" + body + "\n"
const META_KEYS: (keyof PostMeta)[] = [
  "id", "publish_at", "tz", "publish_at_utc", "window_minutes", "visibility",
  "alt_text", "image", "source_path", "content_hash", "mode",
];

export function serializePost(meta: PostMeta, body: string): string {
  const lines = META_KEYS.map((k) => `${k}: ${JSON.stringify(meta[k])}`);
  return `---\n${lines.join("\n")}\n---\n${body}\n`;
}

export function parsePost(text: string): { meta: PostMeta; body: string } {
  if (!text.startsWith("---\n")) throw new Error("post.md: missing front matter");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("post.md: unterminated front matter");
  const meta: Record<string, unknown> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const i = line.indexOf(": ");
    if (i < 0) throw new Error(`post.md: bad front matter line "${line}"`);
    meta[line.slice(0, i)] = JSON.parse(line.slice(i + 2));
  }
  for (const k of META_KEYS) if (!(k in meta)) throw new Error(`post.md: missing "${k}"`);
  let body = text.slice(end + 5);
  if (body.endsWith("\n")) body = body.slice(0, -1);
  return { meta: meta as unknown as PostMeta, body };
}

export interface QueueItem {
  dir: string;
  meta: PostMeta;
  body: string;
  status: Status;
}

export function readItem(dir: string): QueueItem {
  const { meta, body } = parsePost(readFileSync(join(dir, "post.md"), "utf8"));
  const status = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as Status;
  return { dir, meta, body, status };
}

export function readQueue(queueDir: string): QueueItem[] {
  if (!existsSync(queueDir)) return [];
  return readdirSync(queueDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(queueDir, d.name, "post.md")))
    .map((d) => readItem(join(queueDir, d.name)))
    .sort((a, b) => a.meta.publish_at_utc.localeCompare(b.meta.publish_at_utc));
}

export function writeStatus(dir: string, s: Status): void {
  writeFileSync(join(dir, "status.json"), JSON.stringify(s, null, 2) + "\n");
}

// --- Images -----------------------------------------------------------------

export const MAX_PIXELS = 36_152_320; // Images API limit

export function imageInfo(bytes: Uint8Array): { type: "png" | "jpg" | "gif"; width?: number; height?: number } {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) {
    return { type: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length > 10 && b.toString("ascii", 0, 3) === "GIF") {
    return { type: "gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  }
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "jpg" };
  throw new Error("image must be PNG, JPG or GIF");
}

// --- Markdown source files --------------------------------------------------

// The post body is the first fenced code block in the file.
export function extractBody(markdown: string): string {
  const open = /^```[^\n]*\n/m.exec(markdown);
  if (!open) throw new Error("source file has no fenced code block containing the post");
  const start = open.index + open[0].length;
  const close = markdown.indexOf("\n```", start);
  if (close < 0) throw new Error("unterminated fenced code block in source file");
  return markdown.slice(start, close);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// True when the file contains the given heading line (e.g. "## Review") followed
// by non-empty content before the next heading of the same or higher level.
export function hasHeadingWithContent(markdown: string, heading: string): boolean {
  const level = /^(#+)\s/.exec(heading.trim())?.[1].length ?? 2;
  const h = new RegExp(`^${escapeRe(heading.trim())}\\s*$`, "m").exec(markdown);
  if (!h) return false;
  const rest = markdown.slice(h.index + h[0].length);
  const next = rest.search(new RegExp(`^#{1,${level}}\\s`, "m"));
  const section = next < 0 ? rest : rest.slice(0, next);
  return section.trim().length > 0;
}

export function slugify(s: string, max = 40): string {
  return s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "") || "post";
}

export function titleLine(body: string): string {
  return body.split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
}
