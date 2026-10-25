const DAY_MS = 86_400_000;

const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fullDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

export const sameDay = (a: number, b: number) => startOfDay(a) === startOfDay(b);

/** Sidebar timestamp: "3:41 PM", "Yesterday", "Tuesday", "Oct 3", "Oct 3, 2024". */
export function listTime(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return time.format(ms);
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekday.format(ms);
  if (new Date(ms).getFullYear() === new Date(now).getFullYear()) return shortDate.format(ms);
  return fullDate.format(ms);
}

/** Thread separator: "Today 3:41 PM", "Yesterday 9:02 AM", "Tuesday 8:15 PM", "Oct 3, 2024 at 8:15 PM". */
export function separatorTime(ms: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(ms)) / DAY_MS);
  if (days <= 0) return `Today ${time.format(ms)}`;
  if (days === 1) return `Yesterday ${time.format(ms)}`;
  if (days < 7) return `${weekday.format(ms)} ${time.format(ms)}`;
  return `${fullDate.format(ms)} at ${time.format(ms)}`;
}

export const clockTime = (ms: number) => time.format(ms);

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function initials(name: string): string {
  const letters = name
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w[0] ?? ''))
    .map((w) => w[0]!.toUpperCase());
  return letters.length ? (letters[0] + (letters.length > 1 ? letters.at(-1) : '')) : '#';
}

/** Stable hue per name, for avatar backgrounds. */
export function hue(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360;
  return h;
}
