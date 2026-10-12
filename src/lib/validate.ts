import { charCount, MAX_CHARS } from "./text.ts";
import { gapViolations, withinScheduleHours, describe } from "./time.ts";
import { imageInfo, MAX_PIXELS } from "./queue.ts";
import { hhmmToMinutes, type Config } from "./config.ts";

export interface ValidationInput {
  body: string;
  image: Uint8Array;
  publishAtUtc: Date;
  now: Date;
  mode: "scheduled" | "now";
  otherPostTimes: Date[]; // scheduled, publishing or published posts
  tokenExpiresAt: Date | null;
  config: Config;
}

export function validate(v: ValidationInput): string[] {
  const errors: string[] = [];
  const tz = v.config.timezone;
  const n = charCount(v.body);
  if (n === 0) errors.push("post body is empty");
  if (n > MAX_CHARS) errors.push(`post is ${n} characters (conservative count, emoji count 2+); limit is ${MAX_CHARS}`);

  try {
    const info = imageInfo(v.image);
    if (info.width && info.height && info.width * info.height >= MAX_PIXELS) {
      errors.push(`image is ${info.width}x${info.height}; must be under ${MAX_PIXELS} pixels`);
    }
  } catch (e) {
    errors.push((e as Error).message);
  }

  if (v.mode === "scheduled") {
    if (v.publishAtUtc.getTime() < v.now.getTime() + 10 * 60_000) {
      errors.push("publish_at must be at least 10 minutes in the future (use post_now to publish immediately)");
    }
    const start = hhmmToMinutes(v.config.scheduleStartUtc);
    const end = hhmmToMinutes(v.config.scheduleEndUtc);
    if (!withinScheduleHours(v.publishAtUtc, start, end)) {
      errors.push(`${describe(v.publishAtUtc, tz)} is outside the publishing hours (${v.config.scheduleStartUtc}-${v.config.scheduleEndUtc} UTC)`);
    }
  }

  const clashes = gapViolations(v.publishAtUtc, v.otherPostTimes, v.config.minGapHours);
  for (const c of clashes) errors.push(`within ${v.config.minGapHours} h of another post at ${describe(c, tz)}`);

  if (!v.tokenExpiresAt) {
    errors.push("LINKEDIN_TOKEN_EXPIRES_AT is not set; run `npm run login` first");
  } else if (v.publishAtUtc.getTime() > v.tokenExpiresAt.getTime() - 24 * 3_600_000) {
    errors.push(`LinkedIn token expires ${describe(v.tokenExpiresAt, tz)}; renew with \`npm run login\` before scheduling this late`);
  }
  return errors;
}
