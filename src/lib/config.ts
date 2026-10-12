import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  timezone: string;
  windowMinutes: number;
  minGapHours: number;
  scheduleStartUtc: string; // "HH:mm"
  scheduleEndUtc: string; // "HH:mm"
  sourceDir: string | null;
  requireVerificationHeading: string | null;
}

export const CONFIG_FILE = "publisher.config.json";

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function hhmmToMinutes(s: string): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new Error(`"${s}" is not a valid HH:mm time`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export function parseConfig(raw: unknown): Config {
  if (!raw || typeof raw !== "object") throw new Error(`${CONFIG_FILE} must contain a JSON object`);
  const c = raw as Record<string, unknown>;
  const errors: string[] = [];

  const tz = c.timezone;
  if (typeof tz !== "string" || !isValidTimeZone(tz)) {
    errors.push(`"timezone" must be an IANA time zone such as "Europe/London" (got ${JSON.stringify(tz)})`);
  }
  const num = (k: string, min: number) => {
    const v = c[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) errors.push(`"${k}" must be a number >= ${min}`);
  };
  num("windowMinutes", 1);
  num("minGapHours", 0);
  for (const k of ["scheduleStartUtc", "scheduleEndUtc"]) {
    try { hhmmToMinutes(String(c[k])); } catch { errors.push(`"${k}" must be "HH:mm" in UTC`); }
  }
  if (!errors.some((e) => e.includes("schedule")) && hhmmToMinutes(String(c.scheduleStartUtc)) > hhmmToMinutes(String(c.scheduleEndUtc))) {
    errors.push('"scheduleStartUtc" must not be later than "scheduleEndUtc"');
  }
  for (const k of ["sourceDir", "requireVerificationHeading"]) {
    if (c[k] !== null && c[k] !== undefined && typeof c[k] !== "string") errors.push(`"${k}" must be a string or null`);
  }
  if (errors.length) throw new Error(`Invalid ${CONFIG_FILE}:\n- ${errors.join("\n- ")}`);

  return {
    timezone: tz as string,
    windowMinutes: c.windowMinutes as number,
    minGapHours: c.minGapHours as number,
    scheduleStartUtc: c.scheduleStartUtc as string,
    scheduleEndUtc: c.scheduleEndUtc as string,
    sourceDir: (c.sourceDir as string | null | undefined) ?? null,
    requireVerificationHeading: (c.requireVerificationHeading as string | null | undefined) ?? null,
  };
}

export function loadConfig(repoDir: string): Config {
  let text: string;
  try {
    text = readFileSync(join(repoDir, CONFIG_FILE), "utf8");
  } catch {
    throw new Error(`${CONFIG_FILE} not found in ${repoDir}`);
  }
  return parseConfig(JSON.parse(text));
}
