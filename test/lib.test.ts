import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { escapeLittleText, charCount, contentHash } from "../src/lib/text.ts";
import { zonedToUtc, describe, localString, withinScheduleHours, gapViolations, timing } from "../src/lib/time.ts";
import {
  serializePost, parsePost, newStatus, transition, canTransition, imageInfo,
  extractBody, hasHeadingWithContent, titleLine, slugify, type PostMeta,
} from "../src/lib/queue.ts";
import { validate } from "../src/lib/validate.ts";
import { parseConfig, hhmmToMinutes, type Config } from "../src/lib/config.ts";

const PNG_HEADER = Buffer.from("89504e470d0a1a0a0000000d4948445200000438000005460806000000", "hex"); // 1080x1350

const CONFIG: Config = {
  timezone: "Europe/Paris", windowMinutes: 135, minGapHours: 12,
  scheduleStartUtc: "05:00", scheduleEndUtc: "09:50", sourceDir: null, requireVerificationHeading: null,
};

// --- config -----------------------------------------------------------------

test("config: the shipped template is rejected until the time zone is set", () => {
  const template = JSON.parse(readFileSync(new URL("../publisher.config.json", import.meta.url), "utf8"));
  assert.throws(() => parseConfig(template), /IANA time zone/);
  assert.equal(parseConfig({ ...template, timezone: "America/New_York" }).timezone, "America/New_York");
});

test("config: invalid values are reported together", () => {
  assert.throws(
    () => parseConfig({ timezone: "Mars/Olympus", windowMinutes: 0, minGapHours: -1, scheduleStartUtc: "25:00", scheduleEndUtc: "09:50" }),
    (e: Error) => /timezone/.test(e.message) && /windowMinutes/.test(e.message) && /minGapHours/.test(e.message) && /scheduleStartUtc/.test(e.message),
  );
  assert.throws(() => parseConfig({ ...CONFIG, scheduleStartUtc: "10:00", scheduleEndUtc: "09:00" }), /must not be later/);
  assert.equal(hhmmToMinutes("09:50"), 590);
});

// --- text -------------------------------------------------------------------

test("escapes every reserved little-text character", () => {
  const input = "a|b{c}d@e[f]g(h)i<j>k#l\\m*n_o~p";
  assert.equal(escapeLittleText(input), "a\\|b\\{c\\}d\\@e\\[f\\]g\\(h\\)i\\<j\\>k\\#l\\\\m\\*n\\_o\\~p");
});

test("leaves emoji, arrows, dashes and newlines alone", () => {
  const input = "⚠️ Title — line\n\n➡️ next → done ✅";
  assert.equal(escapeLittleText(input), input);
});

test("charCount counts emoji as at least two", () => {
  assert.equal(charCount("ab"), 2);
  assert.equal(charCount("📚"), 2);
  assert.equal(charCount("✅"), 2);
  assert.equal(charCount("⚠️"), 3);
  assert.equal(charCount("→—"), 2);
});

test("contentHash changes when body or image changes", () => {
  const a = contentHash("body", Buffer.from([1, 2, 3]));
  assert.equal(a, contentHash("body", Buffer.from([1, 2, 3])));
  assert.notEqual(a, contentHash("body ", Buffer.from([1, 2, 3])));
  assert.notEqual(a, contentHash("body", Buffer.from([1, 2, 4])));
});

// --- time -------------------------------------------------------------------

test("Paris wall clock converts correctly either side of the October 2026 clock change", () => {
  assert.equal(zonedToUtc("2026-10-24 08:00", "Europe/Paris").toISOString(), "2026-10-24T06:00:00.000Z");
  assert.equal(zonedToUtc("2026-10-26 08:00", "Europe/Paris").toISOString(), "2026-10-26T07:00:00.000Z");
  assert.equal(localString(new Date("2026-10-26T07:00:00Z"), "Europe/Paris"), "2026-10-26 08:00");
});

test("New York and Kolkata (UTC+5:30, no daylight saving)", () => {
  assert.equal(zonedToUtc("2026-10-13 08:30", "America/New_York").toISOString(), "2026-10-13T12:30:00.000Z");
  assert.equal(zonedToUtc("2026-11-02 08:30", "America/New_York").toISOString(), "2026-11-02T13:30:00.000Z");
  assert.equal(zonedToUtc("2026-10-13 11:00", "Asia/Kolkata").toISOString(), "2026-10-13T05:30:00.000Z");
  assert.equal(zonedToUtc("2026-03-29 11:00", "Asia/Kolkata").toISOString(), "2026-03-29T05:30:00.000Z");
});

test("rejects ambiguous and non-existent local times", () => {
  assert.throws(() => zonedToUtc("2026-10-25 02:30", "Europe/Paris"), /ambiguous/);
  assert.throws(() => zonedToUtc("2027-03-28 02:30", "Europe/Paris"), /does not exist/);
  assert.throws(() => zonedToUtc("2026-11-01 01:30", "America/New_York"), /ambiguous/);
  assert.throws(() => zonedToUtc("tomorrow 8am", "Europe/Paris"), /must look like/);
});

test("describe shows local and UTC time", () => {
  assert.equal(describe(new Date("2026-10-13T06:00:00Z"), "Europe/Paris"), "Tue 13 Oct 2026 08:00 CEST (06:00 UTC)");
});

test("schedule hours and minimum gap", () => {
  const s = hhmmToMinutes("05:00");
  const e = hhmmToMinutes("09:50");
  assert.equal(withinScheduleHours(new Date("2026-10-13T06:00:00Z"), s, e), true);
  assert.equal(withinScheduleHours(new Date("2026-10-13T09:51:00Z"), s, e), false);
  assert.equal(withinScheduleHours(new Date("2026-10-13T04:59:00Z"), s, e), false);
  const t = new Date("2026-10-13T06:00:00Z");
  assert.equal(gapViolations(t, [new Date("2026-10-13T17:59:00Z")], 12).length, 1);
  assert.equal(gapViolations(t, [new Date("2026-10-13T18:00:00Z")], 12).length, 0);
  assert.equal(gapViolations(t, [new Date("2026-10-13T06:01:00Z")], 0).length, 0);
});

test("timing: early, due, expired", () => {
  const at = new Date("2026-10-13T06:00:00Z");
  assert.equal(timing(new Date("2026-10-13T05:59:00Z"), at, 135), "early");
  assert.equal(timing(new Date("2026-10-13T08:15:00Z"), at, 135), "due");
  assert.equal(timing(new Date("2026-10-13T08:16:00Z"), at, 135), "expired");
});

// --- queue ------------------------------------------------------------------

const meta: PostMeta = {
  id: "20261013-0800-test", publish_at: "2026-10-13 08:00", tz: "Europe/Paris",
  publish_at_utc: "2026-10-13T06:00:00.000Z", window_minutes: 135, visibility: "CONNECTIONS",
  alt_text: 'Alt: with "quotes"', image: "image.png", source_path: "",
  content_hash: "abc", mode: "scheduled",
};

test("post.md round-trips body exactly, including blank lines", () => {
  const body = "Title\n\n⚠️ First\nsecond line\n\n";
  const parsed = parsePost(serializePost(meta, body));
  assert.deepEqual(parsed.meta, meta);
  assert.equal(parsed.body, body);
});

test("state machine allows only legal transitions", () => {
  let s = newStatus(new Date("2026-10-12T00:00:00Z"));
  s = transition(s, "publishing");
  s = transition(s, "published");
  assert.equal(s.state, "published");
  assert.throws(() => transition(s, "publishing"), /illegal/);
  assert.equal(canTransition("publishing", "scheduled"), false);
  assert.equal(canTransition("needs_attention", "publishing"), false);
});

test("imageInfo reads PNG dimensions and rejects other files", () => {
  assert.deepEqual(imageInfo(PNG_HEADER), { type: "png", width: 1080, height: 1350 });
  assert.throws(() => imageInfo(Buffer.from("not an image")), /PNG, JPG or GIF/);
});

const SOURCE = [
  "# A post", "", "Some notes.", "", "```", "Line one", "", "⚠️ Line two", "```", "",
  "## Comment", "", "```", "comment", "```", "", "## Review", "- Checked.", "", "### Detail", "- more", "",
].join("\n");

test("extractBody takes the first fenced block, under any heading", () => {
  assert.equal(extractBody(SOURCE), "Line one\n\n⚠️ Line two");
  assert.equal(titleLine(extractBody(SOURCE)), "Line one");
  assert.throws(() => extractBody("# no fence here"), /no fenced code block/);
});

test("hasHeadingWithContent checks the named section only", () => {
  assert.equal(hasHeadingWithContent(SOURCE, "## Review"), true);
  assert.equal(hasHeadingWithContent(SOURCE.replace("- Checked.", ""), "## Review"), true); // sub-heading content still counts
  assert.equal(hasHeadingWithContent("## Review\n\n## Next\ntext", "## Review"), false);
  assert.equal(hasHeadingWithContent(SOURCE, "## Missing"), false);
});

test("slugify makes safe ids from titles and file names", () => {
  assert.equal(slugify("I let my agents decide - once!"), "i-let-my-agents-decide-once");
  assert.equal(slugify("12-three-runs"), "12-three-runs");
  assert.equal(slugify("⚠️"), "post");
  assert.ok(slugify("a".repeat(100)).length <= 40);
});

// --- validate ---------------------------------------------------------------

test("validate catches the main failure cases", () => {
  const now = new Date("2026-10-12T19:00:00Z");
  const ok = {
    body: "x".repeat(2000), image: PNG_HEADER, publishAtUtc: new Date("2026-10-13T06:00:00Z"), now,
    mode: "scheduled" as const, otherPostTimes: [], tokenExpiresAt: new Date("2026-12-01T00:00:00Z"), config: CONFIG,
  };
  assert.deepEqual(validate(ok), []);
  assert.match(validate({ ...ok, body: "x".repeat(3001) }).join(), /limit is 3000/);
  assert.match(validate({ ...ok, publishAtUtc: new Date("2026-10-13T12:00:00Z") }).join(), /outside the publishing hours/);
  assert.match(validate({ ...ok, otherPostTimes: [new Date("2026-10-13T10:00:00Z")] }).join(), /within 12 h/);
  assert.deepEqual(validate({ ...ok, otherPostTimes: [new Date("2026-10-13T10:00:00Z")], config: { ...CONFIG, minGapHours: 0 } }), []);
  assert.match(validate({ ...ok, tokenExpiresAt: new Date("2026-10-13T12:00:00Z") }).join(), /token expires/);
  assert.match(validate({ ...ok, tokenExpiresAt: null }).join(), /npm run login/);
  assert.match(validate({ ...ok, image: Buffer.from("nope") }).join(), /PNG, JPG or GIF/);
  assert.deepEqual(validate({ ...ok, mode: "now", publishAtUtc: now }), []);
});
