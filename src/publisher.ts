// Runs in GitHub Actions (publish.yml). Publishes at most one due post per run.
//
// Safety rules:
// 1. "publishing" is committed and pushed BEFORE any LinkedIn call. If that push
//    fails, nothing is posted.
// 2. A post in "publishing" or "needs_attention" is never picked up again.
// 3. Only definite LinkedIn rejections (4xx about media) are retried. A 5xx,
//    timeout or missing post ID may mean the post exists: no retry, open an issue.
// 4. A missed window expires the post. It is never published late.

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { readQueue, writeStatus, transition, type QueueItem } from "./lib/queue.ts";
import { contentHash, escapeLittleText } from "./lib/text.ts";
import { timing, describe, gapViolations } from "./lib/time.ts";
import { loadConfig } from "./lib/config.ts";
import { uploadImage, createPost, postUrl, isMediaNotReady, LinkedInError, postBody } from "./lib/linkedin.ts";
import { commitAndPush, openIssue, runUrl } from "./lib/gitops.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const QUEUE = join(ROOT, "queue");
const env = process.env;

const enabled = env.PUBLISHING_ENABLED === "true";
const dryRun = env.DRY_RUN !== "false" || !enabled; // anything but an explicit false is a dry run
const forceId = (env.FORCE_ID ?? "").trim();
const sendAltText = env.LINKEDIN_SEND_ALT_TEXT !== "false";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(msg: string) {
  console.log(`[publisher] ${msg}`);
}

function statusPath(item: QueueItem) {
  return relative(ROOT, join(item.dir, "status.json"));
}

function fail(item: QueueItem, note: string, title: string): void {
  item.status = transition(item.status, "needs_attention", note);
  writeStatus(item.dir, item.status);
  const pushed = commitAndPush(ROOT, [statusPath(item)], `publish: ${item.meta.id} needs attention`, 3);
  openIssue(ROOT, title, `${note}\n\nPost: \`${item.meta.id}\`\nRun: ${runUrl()}${pushed ? "" : "\n\n**The status commit also failed to push.** The remote may still show `publishing`."}`);
}

async function main() {
  const config = loadConfig(ROOT);
  const tz = config.timezone;
  log(`mode: ${dryRun ? "DRY RUN (no LinkedIn calls, no commits)" : "LIVE"}; enabled=${enabled}; timezone=${tz}`);
  const now = new Date();
  const items = readQueue(QUEUE);
  const published = items.filter((i) => i.status.state === "published").map((i) => new Date(i.meta.publish_at_utc));

  // 1. Expire anything whose window has passed.
  for (const item of items.filter((i) => i.status.state === "scheduled")) {
    const at = new Date(item.meta.publish_at_utc);
    if (timing(now, at, item.meta.window_minutes) !== "expired") continue;
    log(`expired: ${item.meta.id} (${describe(at, tz)})`);
    if (dryRun) continue;
    item.status = transition(item.status, "expired", `window of ${item.meta.window_minutes} min missed`);
    writeStatus(item.dir, item.status);
    commitAndPush(ROOT, [statusPath(item)], `publish: ${item.meta.id} expired`, 3);
    openIssue(ROOT, `LinkedIn post expired: ${item.meta.id}`,
      `Scheduled for ${describe(at, tz)} but no run reached it within ${item.meta.window_minutes} minutes. It was NOT posted.\n\nRun: ${runUrl()}`);
  }

  // 2. Pick at most one due post.
  const due = items.filter((i) => {
    if (i.status.state !== "scheduled") return false;
    if (forceId && i.meta.id !== forceId) return false;
    return timing(now, new Date(i.meta.publish_at_utc), i.meta.window_minutes) === "due";
  });
  if (due.length === 0) {
    log(forceId ? `nothing due for FORCE_ID=${forceId}` : "nothing due");
    return;
  }
  const item = due[0];
  const at = new Date(item.meta.publish_at_utc);
  log(`due: ${item.meta.id} (${describe(at, tz)}), visibility ${item.meta.visibility}`);

  // 3. Integrity checks.
  const image = readFileSync(join(item.dir, item.meta.image));
  const hash = contentHash(item.body, image);
  if (hash !== item.meta.content_hash) {
    log("content hash mismatch");
    if (!dryRun) fail(item, `Content changed after approval (hash ${hash.slice(0, 12)} != ${item.meta.content_hash.slice(0, 12)}). Not posted.`,
      `LinkedIn post blocked (content changed): ${item.meta.id}`);
    process.exitCode = 1;
    return;
  }
  const clash = gapViolations(at, published, config.minGapHours);
  if (clash.length) {
    log(`minimum gap of ${config.minGapHours} h violated by an already-published post`);
    if (!dryRun) fail(item, `Another post was published at ${describe(clash[0], tz)}, within ${config.minGapHours} h. Not posted.`,
      `LinkedIn post blocked (minimum gap): ${item.meta.id}`);
    process.exitCode = 1;
    return;
  }

  const token = env.LINKEDIN_ACCESS_TOKEN ?? "";
  const author = env.LINKEDIN_PERSON_URN ?? "";
  const version = env.LINKEDIN_API_VERSION ?? "";
  const commentary = escapeLittleText(item.body);
  const altText = sendAltText ? item.meta.alt_text : undefined;

  if (dryRun) {
    const preview = postBody({ author: author ? "urn:li:person:<redacted>" : "<missing>", commentary, visibility: item.meta.visibility, imageUrn: "urn:li:image:<from upload>", altText });
    log(`would upload ${item.meta.image} (${image.length} bytes) and send POST /rest/posts with Linkedin-Version ${version || "<missing>"}:`);
    console.log(JSON.stringify(preview, null, 2));
    log(`secrets present: token=${token ? "yes" : "NO"}, person_urn=${author ? "yes" : "NO"}`);
    return;
  }
  if (!token || !author || !/^\d{6}$/.test(version)) {
    openIssue(ROOT, "LinkedIn publisher is missing configuration",
      `LINKEDIN_ACCESS_TOKEN present: ${!!token}\nLINKEDIN_PERSON_URN present: ${!!author}\nLINKEDIN_API_VERSION: "${version}"\n\nNothing was posted. Run: ${runUrl()}`);
    process.exitCode = 1;
    return;
  }

  // 4. Claim the post. If this push fails, stop before touching LinkedIn.
  item.status = transition(item.status, "publishing", `run ${env.GITHUB_RUN_ID ?? "local"}`);
  item.status.run_id = env.GITHUB_RUN_ID;
  writeStatus(item.dir, item.status);
  if (!commitAndPush(ROOT, [statusPath(item)], `publish: ${item.meta.id} publishing`, 0)) {
    log("could not push the publishing claim; aborting without posting");
    openIssue(ROOT, `LinkedIn post not attempted (push failed): ${item.meta.id}`,
      `The run could not record the "publishing" claim, so it did not post. The next run will try again if the window is still open.\n\nRun: ${runUrl()}`);
    process.exitCode = 1;
    return;
  }

  // 5. Upload the image and create the post.
  const client = { token, version };
  let urn: string;
  try {
    const imageUrn = await uploadImage(client, author, image);
    log(`image uploaded: ${imageUrn}`);
    await sleep(10_000);
    const delays = [0, 15_000, 30_000, 60_000];
    let lastErr: unknown;
    urn = "";
    for (const d of delays) {
      if (d) { log(`media not ready, retrying in ${d / 1000}s`); await sleep(d); }
      try {
        urn = await createPost(client, { author, commentary, visibility: item.meta.visibility, imageUrn, altText });
        break;
      } catch (e) {
        lastErr = e;
        if (!isMediaNotReady(e)) throw e;
      }
    }
    if (!urn) throw lastErr;
  } catch (e) {
    const le = e instanceof LinkedInError ? e : new LinkedInError("unknown", (e as Error).message);
    const certain = le.kind === "rejected";
    const note = certain
      ? `LinkedIn rejected the request, so nothing was posted: ${le.message}\n\n\`\`\`\n${le.body ?? ""}\n\`\`\``
      : `Outcome UNKNOWN: ${le.message}. The post may or may not exist. Check your LinkedIn activity before doing anything; it will not be retried automatically.`;
    log(note.split("\n")[0]);
    fail(item, note, `LinkedIn post ${certain ? "rejected" : "outcome unknown"}: ${item.meta.id}`);
    process.exitCode = 1;
    return;
  }

  // 6. Record success. Retry the push; if it still fails, leave "publishing" and say so.
  log(`published: ${urn}`);
  item.status = transition(item.status, "published", urn);
  item.status.post_urn = urn;
  item.status.post_url = postUrl(urn);
  writeStatus(item.dir, item.status);
  if (!commitAndPush(ROOT, [statusPath(item)], `publish: ${item.meta.id} published`, 3)) {
    openIssue(ROOT, `LinkedIn post published but not recorded: ${item.meta.id}`,
      `The post IS live: ${postUrl(urn)}\n\nThe status commit failed to push, so the repo still says "publishing". It will not be re-posted. Update queue/${item.meta.id}/status.json by hand.\n\nRun: ${runUrl()}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`::error::${(e as Error).stack ?? e}`);
  process.exitCode = 1;
});
