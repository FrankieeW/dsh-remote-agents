const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Milliseconds for a numeric or ISO timestamp; 0 when absent or invalid. */
export function timestampOf(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Compact sidebar distance in DSH's native buckets: now, 5min, 3h, 2d, 4mo, 1y. */
export function relativeTimeLabel(value, now = Date.now()) {
  const time = timestampOf(value);
  if (!time) return "";
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) return "now";
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}min`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)}d`;
  if (elapsed < 365 * DAY) return `${Math.floor(elapsed / (30 * DAY))}mo`;
  return `${Math.floor(elapsed / (365 * DAY))}y`;
}

/** Hover-card variant: "5min ago", with the now bucket left bare. */
export function relativeTimeAgo(value, now = Date.now()) {
  const label = relativeTimeLabel(value, now);
  return label === "" || label === "now" ? label : `${label} ago`;
}
