/**
 * App-wide timezone: America/Chicago (US Central).
 * All date/time displays and "today" calculations should route through here
 * so the UI is consistent regardless of the viewer's local timezone.
 */
export const APP_TIMEZONE = "America/Chicago";
export const APP_LOCALE = "en-US";

/** Today as YYYY-MM-DD in app timezone (Chicago). */
export function todayInAppTz(): string {
  return isoDateInAppTz(new Date());
}

/** Format any Date as YYYY-MM-DD in app timezone. */
export function isoDateInAppTz(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Shift an ISO date (YYYY-MM-DD) by `days`, keeping it as YYYY-MM-DD. */
export function shiftIsoDate(iso: string, days: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Format a UTC ISO timestamp as "h:mm a CT" in app timezone. */
export function formatTimeInAppTz(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString(APP_LOCALE, {
      hour: "numeric",
      minute: "2-digit",
      timeZone: APP_TIMEZONE,
      timeZoneName: "short",
    });
  } catch {
    return "";
  }
}

/** Format a UTC ISO timestamp as a full date+time string in app timezone. */
export function formatDateTimeInAppTz(iso: string): string {
  try {
    const d = new Date(iso);
    // Use explicit options (not dateStyle/timeStyle) — ICU versions differ
    // between Node SSR and the browser and cause hydration mismatches.
    return d.toLocaleString(APP_LOCALE, {
      timeZone: APP_TIMEZONE,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return "";
  }
}

