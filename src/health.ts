// Runs weekly in GitHub Actions (health.yml). Opens an issue for anything that
// would otherwise fail silently. Issues are de-duplicated by title.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readQueue } from "./lib/queue.ts";
import { describe } from "./lib/time.ts";
import { loadConfig } from "./lib/config.ts";
import { openIssue, runUrl } from "./lib/gitops.ts";

const ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const now = new Date();
const DAY = 86_400_000;
const problems: string[] = [];

let tz = "UTC";
try {
  tz = loadConfig(ROOT).timezone;
} catch (e) {
  openIssue(ROOT, "publisher.config.json is invalid", `${(e as Error).message}\n\nScheduled posts cannot be published until this is fixed.`);
  problems.push("config invalid");
}

// Token expiry
const exp = process.env.LINKEDIN_TOKEN_EXPIRES_AT;
if (!exp) {
  openIssue(ROOT, "LinkedIn token expiry unknown", "LINKEDIN_TOKEN_EXPIRES_AT is not set. Run `npm run login`.");
  problems.push("token expiry unknown");
} else {
  const days = Math.floor((new Date(exp).getTime() - now.getTime()) / DAY);
  if (days < 10) {
    openIssue(ROOT, "Renew the LinkedIn token",
      `The token expires ${describe(new Date(exp), tz)} (${days} days). Run \`npm run login\` in your clone of this repository.\n\nPosts scheduled after expiry will fail.`);
    problems.push(`token expires in ${days} days`);
  }
}

// API version age (LinkedIn supports each monthly version for at least a year)
const v = process.env.LINKEDIN_API_VERSION ?? "";
const m = /^(\d{4})(\d{2})$/.exec(v);
if (!m) {
  openIssue(ROOT, "LinkedIn API version not set", `LINKEDIN_API_VERSION is "${v}". Set it to a supported YYYYMM version.`);
  problems.push("API version missing");
} else {
  const months = (now.getUTCFullYear() - Number(m[1])) * 12 + (now.getUTCMonth() + 1 - Number(m[2]));
  if (months >= 10) {
    openIssue(ROOT, `Update LINKEDIN_API_VERSION (${v} is ${months} months old)`,
      "LinkedIn sunsets versions after about a year. Pick the latest from https://learn.microsoft.com/en-us/linkedin/marketing/versioning and publish a CONNECTIONS-visibility test post.");
    problems.push(`API version ${months} months old`);
  }
}

// Stuck or failed posts
for (const item of readQueue(join(ROOT, "queue"))) {
  const s = item.status;
  const age = now.getTime() - new Date(s.updated_at).getTime();
  if (s.state === "publishing" && age > 3_600_000) {
    openIssue(ROOT, `LinkedIn post stuck in publishing: ${item.meta.id}`,
      `Status has been "publishing" since ${s.updated_at}. A run may have been cut off mid-post. Check your LinkedIn activity, then set the status by hand. It will not be retried automatically.`);
    problems.push(`${item.meta.id} stuck`);
  }
  if (s.state === "needs_attention") problems.push(`${item.meta.id} needs attention`);
}

console.log(problems.length ? `[health] ${problems.join("; ")}` : "[health] all good");
console.log(`[health] run: ${runUrl()}`);
