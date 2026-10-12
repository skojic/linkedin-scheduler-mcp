export const POST_NOW_WINDOW_MINUTES = 30;

const HOUR = 3_600_000;

function parts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) {
    if (x.type !== "literal") p[x.type] = Number(x.value);
  }
  return p as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

function offsetMs(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export function localString(date: Date, tz: string): string {
  const p = parts(date.getTime(), tz);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)} ${z(p.hour)}:${z(p.minute)}`;
}

// Converts "YYYY-MM-DD HH:mm" wall-clock time in tz to a UTC Date.
// Rejects times that do not exist or are ambiguous around clock changes.
export function zonedToUtc(local: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) throw new Error(`publish_at must look like "2026-10-13 08:00", got "${local}"`);
  const [, y, mo, d, h, mi] = m.map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const offsets = new Set([offsetMs(naive - 24 * HOUR, tz), offsetMs(naive, tz), offsetMs(naive + 24 * HOUR, tz)]);
  const want = local.trim().replace("T", " ");
  const matches = [...offsets].map((o) => naive - o).filter((ms) => localString(new Date(ms), tz) === want);
  const unique = [...new Set(matches)];
  if (unique.length === 0) throw new Error(`${want} does not exist in ${tz} (clock change)`);
  if (unique.length > 1) throw new Error(`${want} is ambiguous in ${tz} (clock change)`);
  return new Date(unique[0]);
}

// e.g. "Tue 13 Oct 2026 08:00 CEST (06:00 UTC)"
export function describe(date: Date, tz: string): string {
  const local = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);
  const g = (t: string) => local.find((x) => x.type === t)?.value ?? "";
  const utc = date.toISOString().slice(11, 16);
  return `${g("weekday")} ${g("day")} ${g("month")} ${g("year")} ${g("hour")}:${g("minute")} ${g("timeZoneName")} (${utc} UTC)`;
}

export function withinScheduleHours(utc: Date, startMin: number, endMin: number): boolean {
  const min = utc.getUTCHours() * 60 + utc.getUTCMinutes();
  return min >= startMin && min <= endMin;
}

export function gapViolations(candidate: Date, others: Date[], hours: number): Date[] {
  if (hours <= 0) return [];
  return others.filter((o) => Math.abs(o.getTime() - candidate.getTime()) < hours * HOUR);
}

export type Timing = "early" | "due" | "expired";

export function timing(now: Date, publishAt: Date, windowMinutes: number): Timing {
  const t = now.getTime();
  const start = publishAt.getTime();
  if (t < start) return "early";
  if (t > start + windowMinutes * 60_000) return "expired";
  return "due";
}
