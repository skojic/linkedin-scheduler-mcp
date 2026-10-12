// Local MCP server (stdio). Every write goes through git: the tool validates,
// writes queue/<id>/, commits and pushes. The cloud publisher (publish.yml)
// does the actual posting.
//
// LP_REPO_DIR: absolute path to your private copy of this repository.
// Defaults to the repository this file lives in.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readQueue, readItem, writeStatus, transition, newStatus, serializePost, parsePost,
  extractBody, hasHeadingWithContent, titleLine, imageInfo, slugify, type PostMeta, type QueueItem,
} from "../lib/queue.ts";
import { contentHash, charCount } from "../lib/text.ts";
import { validate } from "../lib/validate.ts";
import { loadConfig, type Config } from "../lib/config.ts";
import { zonedToUtc, describe, localString, POST_NOW_WINDOW_MINUTES } from "../lib/time.ts";
import { run, tryRun, commitAndPush } from "../lib/gitops.ts";

const ROOT = process.env.LP_REPO_DIR ? realpathSync(process.env.LP_REPO_DIR) : join(fileURLToPath(import.meta.url), "..", "..", "..");
const QUEUE = join(ROOT, "queue");

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): Result => ({ content: [{ type: "text", text }] });
const err = (text: string): Result => ({ content: [{ type: "text", text }], isError: true });

function ensureCleanAndSynced(): void {
  const dirty = run("git", ["status", "--porcelain"], ROOT);
  if (dirty) throw new Error(`the publisher repo has uncommitted changes; resolve them first:\n${dirty}`);
  const pull = tryRun("git", ["pull", "--rebase", "--quiet"], ROOT);
  if (!pull.ok) throw new Error(`git pull failed: ${pull.out}`);
}

function tokenExpiry(): Date | null {
  const r = tryRun("gh", ["variable", "get", "LINKEDIN_TOKEN_EXPIRES_AT"], ROOT);
  return r.ok && r.out ? new Date(r.out) : null;
}

function activeTimes(items: QueueItem[], excludeId?: string): Date[] {
  return items
    .filter((i) => i.meta.id !== excludeId && ["scheduled", "publishing", "published"].includes(i.status.state))
    .map((i) => new Date(i.meta.publish_at_utc));
}

// Push, and if it fails undo our own just-made commit so the local repo never diverges.
function pushOrUndo(paths: string[], message: string): void {
  if (commitAndPush(ROOT, paths, message, 0)) return;
  tryRun("git", ["reset", "--hard", "HEAD~1"], ROOT);
  tryRun("git", ["pull", "--rebase", "--quiet"], ROOT);
  throw new Error("push to GitHub failed (the remote changed or the network is down). Nothing was queued; run list_scheduled and try again.");
}

function findItem(id: string): QueueItem {
  const dir = join(QUEUE, id);
  if (!existsSync(join(dir, "post.md"))) throw new Error(`no queued post with id "${id}"`);
  return readItem(dir);
}

interface ScheduleArgs {
  text?: string;
  source_path?: string;
  image_path: string;
  publish_at?: string;
  visibility?: "PUBLIC" | "CONNECTIONS";
  alt_text?: string;
}

function readBody(a: ScheduleArgs, config: Config): { body: string; source: string; slugBase: string } {
  if ((a.text === undefined) === (a.source_path === undefined)) throw new Error("give exactly one of text or source_path");
  if (a.text !== undefined) {
    if (config.requireVerificationHeading) throw new Error(`requireVerificationHeading is set in publisher.config.json, so posts must come from a source_path file containing "${config.requireVerificationHeading}"`);
    const body = a.text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
    return { body, source: "", slugBase: titleLine(body) };
  }
  const src = realpathSync(a.source_path!);
  if (config.sourceDir) {
    const dir = realpathSync(config.sourceDir);
    if (!src.startsWith(dir + sep)) throw new Error(`source_path must be inside ${dir} (sourceDir in publisher.config.json)`);
  }
  const md = readFileSync(src, "utf8");
  if (config.requireVerificationHeading && !hasHeadingWithContent(md, config.requireVerificationHeading)) {
    throw new Error(`source file has no non-empty "${config.requireVerificationHeading}" section`);
  }
  return { body: extractBody(md), source: src, slugBase: basename(src, extname(src)) };
}

function schedule(a: ScheduleArgs, mode: "scheduled" | "now"): Result {
  ensureCleanAndSynced();
  const config = loadConfig(ROOT);
  const tz = config.timezone;
  const { body, source, slugBase } = readBody(a, config);

  const imgPath = realpathSync(a.image_path);
  const image = readFileSync(imgPath);
  const info = imageInfo(image);

  const now = new Date();
  const publishAt = mode === "now" ? now : zonedToUtc(a.publish_at ?? "", tz);
  const items = readQueue(QUEUE);
  const errors = validate({ body, image, publishAtUtc: publishAt, now, mode, otherPostTimes: activeTimes(items), tokenExpiresAt: tokenExpiry(), config });
  if (errors.length) return err(`Not queued:\n- ${errors.join("\n- ")}`);

  const local = localString(publishAt, tz);
  const stamp = local.replace(/[-: ]/g, "").replace(/^(\d{8})(\d{4})$/, "$1-$2");
  const base = `${stamp}-${slugify(slugBase)}`;
  let id = base;
  for (let n = 2; existsSync(join(QUEUE, id)); n++) id = `${base}-${n}`;

  const dir = join(QUEUE, id);
  mkdirSync(dir, { recursive: true });
  const imageName = `image.${info.type}`;
  copyFileSync(imgPath, join(dir, imageName));
  const html = join(dirname(imgPath), basename(imgPath, extname(imgPath)) + ".html");
  if (existsSync(html)) copyFileSync(html, join(dir, "image.html"));

  const meta: PostMeta = {
    id,
    publish_at: local,
    tz,
    publish_at_utc: publishAt.toISOString(),
    window_minutes: mode === "now" ? POST_NOW_WINDOW_MINUTES : config.windowMinutes,
    visibility: a.visibility ?? "PUBLIC",
    alt_text: (a.alt_text ?? titleLine(body)).slice(0, 300),
    image: imageName,
    source_path: source,
    content_hash: contentHash(body, image),
    mode,
  };
  writeFileSync(join(dir, "post.md"), serializePost(meta, body));
  writeStatus(dir, newStatus(now));

  pushOrUndo([relative(ROOT, dir)], `queue: ${id} for ${describe(publishAt, tz)}`);

  let dispatched = "";
  if (mode === "now") {
    const r = tryRun("gh", ["workflow", "run", "publish.yml", "-f", `id=${id}`], ROOT);
    dispatched = r.ok
      ? "\nPublish run triggered; it normally starts within a minute. Use publisher_status to follow it."
      : `\nQueued, but triggering the run failed (${r.out}). Trigger it with: gh workflow run publish.yml -f id=${id}`;
  }
  const dims = info.width ? `${info.width}x${info.height}` : "size not read";
  return ok(
    `Queued ${id}\n` +
    `When: ${mode === "now" ? "now" : describe(publishAt, tz)} (window ${meta.window_minutes} min)\n` +
    `Visibility: ${meta.visibility}\n` +
    `Text: ${charCount(body)} characters (conservative count); first line: "${titleLine(body)}"\n` +
    `Image: ${basename(imgPath)} -> ${imageName} (${dims}); alt text: "${meta.alt_text}"\n` +
    `Content hash: ${meta.content_hash.slice(0, 12)}` + dispatched,
  );
}

const server = new McpServer({ name: "linkedin-scheduler-mcp", version: "1.0.0" });

const wrap = (fn: () => Result): Result => {
  try { return fn(); } catch (e) { return err((e as Error).message); }
};

const postShape = {
  text: z.string().optional().describe("The post body. Give this or source_path, not both."),
  source_path: z.string().optional().describe("Absolute path to a Markdown file; the first fenced code block is the post body. Give this or text, not both."),
  image_path: z.string().describe("Absolute path to a PNG, JPG or GIF. A sibling .html file with the same name is archived alongside it."),
  visibility: z.enum(["PUBLIC", "CONNECTIONS"]).optional().describe("Default PUBLIC. Use CONNECTIONS for test posts."),
  alt_text: z.string().optional().describe("Image alt text; defaults to the first line of the post"),
};
const timeDescription = 'Local wall-clock time in the time zone set in publisher.config.json, as "YYYY-MM-DD HH:mm", e.g. "2026-10-13 08:30"';

server.registerTool("schedule_post", {
  title: "Schedule a LinkedIn post",
  description: "Validate and queue a post with an image for publishing at a local time. Published from GitHub Actions, so the computer can be off. Commits and pushes to the private queue repository.",
  inputSchema: { ...postShape, publish_at: z.string().describe(timeDescription) },
}, async (a) => wrap(() => schedule(a, "scheduled")));

server.registerTool("post_now", {
  title: "Publish a LinkedIn post now",
  description: "Validate, queue and immediately trigger the cloud publisher for this post.",
  inputSchema: postShape,
}, async (a) => wrap(() => schedule(a, "now")));

server.registerTool("list_scheduled", {
  title: "List queued LinkedIn posts",
  description: "Show every queued post with its state and time.",
  inputSchema: {},
}, async () => wrap(() => {
  ensureCleanAndSynced();
  const tz = loadConfig(ROOT).timezone;
  const items = readQueue(QUEUE);
  if (!items.length) return ok("Queue is empty.");
  return ok(items.map((i) =>
    `${i.status.state.padEnd(15)} ${describe(new Date(i.meta.publish_at_utc), tz)}  ${i.meta.id}  [${i.meta.visibility}]` +
    (i.status.post_url ? `\n${" ".repeat(16)}${i.status.post_url}` : "")).join("\n"));
}));

server.registerTool("cancel_post", {
  title: "Cancel a queued LinkedIn post",
  description: "Cancel a post that is still in the scheduled state.",
  inputSchema: { id: z.string() },
}, async ({ id }) => wrap(() => {
  ensureCleanAndSynced();
  const item = findItem(id);
  if (item.status.state !== "scheduled") return err(`"${id}" is ${item.status.state}; only scheduled posts can be cancelled.`);
  writeStatus(item.dir, transition(item.status, "cancelled", "cancelled via MCP"));
  pushOrUndo([relative(ROOT, join(item.dir, "status.json"))], `queue: cancel ${id}`);
  return ok(`Cancelled ${id}.`);
}));

server.registerTool("reschedule_post", {
  title: "Reschedule a queued LinkedIn post",
  description: "Move a scheduled post to a new local time. Re-validates timing; text and image stay locked.",
  inputSchema: { id: z.string(), publish_at: z.string().describe(timeDescription) },
}, async ({ id, publish_at }) => wrap(() => {
  ensureCleanAndSynced();
  const config = loadConfig(ROOT);
  const tz = config.timezone;
  const item = findItem(id);
  if (item.status.state !== "scheduled") return err(`"${id}" is ${item.status.state}; only scheduled posts can be rescheduled.`);
  const when = zonedToUtc(publish_at, tz);
  const image = readFileSync(join(item.dir, item.meta.image));
  const errors = validate({ body: item.body, image, publishAtUtc: when, now: new Date(), mode: "scheduled", otherPostTimes: activeTimes(readQueue(QUEUE), id), tokenExpiresAt: tokenExpiry(), config });
  if (errors.length) return err(`Not rescheduled:\n- ${errors.join("\n- ")}`);
  const postFile = join(item.dir, "post.md");
  const { meta, body } = parsePost(readFileSync(postFile, "utf8"));
  writeFileSync(postFile, serializePost({ ...meta, publish_at: localString(when, tz), tz, publish_at_utc: when.toISOString() }, body));
  writeStatus(item.dir, transition(item.status, "scheduled", `rescheduled to ${when.toISOString()}`));
  pushOrUndo([relative(ROOT, item.dir)], `queue: reschedule ${id} to ${describe(when, tz)}`);
  return ok(`Rescheduled ${id} to ${describe(when, tz)}.`);
}));

server.registerTool("publisher_status", {
  title: "LinkedIn publisher status",
  description: "Configuration, token expiry, API version, kill-switch state, recent runs and open publisher issues.",
  inputSchema: {},
}, async () => wrap(() => {
  let cfg: string;
  let tz = "UTC";
  try {
    const c = loadConfig(ROOT);
    tz = c.timezone;
    cfg = `time zone ${c.timezone}, publishing hours ${c.scheduleStartUtc}-${c.scheduleEndUtc} UTC, window ${c.windowMinutes} min, minimum gap ${c.minGapHours} h`;
  } catch (e) {
    cfg = `INVALID: ${(e as Error).message}`;
  }
  const vars = tryRun("gh", ["variable", "list"], ROOT).out;
  const runs = tryRun("gh", ["run", "list", "--workflow", "publish.yml", "-L", "5"], ROOT).out;
  const issues = tryRun("gh", ["issue", "list", "--state", "open", "--label", "publisher"], ROOT).out;
  const exp = tokenExpiry();
  const days = exp ? Math.floor((exp.getTime() - Date.now()) / 86_400_000) : null;
  return ok(
    `Repository: ${ROOT}\nConfig: ${cfg}\n` +
    `Token: ${exp ? `expires ${describe(exp, tz)} (${days} days)` : "not set; run npm run login"}\n\n` +
    `Variables:\n${vars || "(none)"}\n\nRecent publish runs:\n${runs || "(none)"}\n\nOpen publisher issues:\n${issues || "(none)"}`,
  );
}));

await server.connect(new StdioServerTransport());
