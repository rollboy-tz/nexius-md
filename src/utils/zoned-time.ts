// path: src/utils/zoned-time.ts

/** Time zone maths using only Intl, so there is no date library to keep patched. */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function localParts(date: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** "20260514" in the given zone. Counters roll over at local midnight, not UTC midnight. */
export function localDateKey(date: Date, timeZone: string): string {
  const p = localParts(date, timeZone);
  return `${p.year}${pad(p.month)}${pad(p.day)}`;
}

/** "2026051409" in the given zone. */
export function localHourKey(date: Date, timeZone: string): string {
  return `${localDateKey(date, timeZone)}${pad(localParts(date, timeZone).hour)}`;
}

/** How far the zone is ahead of UTC at this instant, in ms (handles daylight saving). */
function offsetAt(utcMs: number, timeZone: string): number {
  const p = localParts(new Date(utcMs), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `timeZone` reads y-m-d hh:mm. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = asUtc - offsetAt(asUtc, timeZone);
  return new Date(asUtc - offsetAt(firstGuess, timeZone));
}

export function minutesOfDay(hhmm: string): number {
  const [hours = '0', minutes = '0'] = hhmm.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** Milliseconds until the next time the wall clock in `timeZone` reads `hhmm` (today if still ahead, else tomorrow). */
export function msUntilLocalTime(from: Date, timeZone: string, hhmm: string): number {
  const { year, month, day } = localParts(from, timeZone);
  const minutes = minutesOfDay(hhmm);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;

  for (let dayOffset = 0; dayOffset <= 2; dayOffset += 1) {
    const date = new Date(Date.UTC(year, month - 1, day + dayOffset));
    const candidate = zonedTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute, timeZone);
    if (candidate.getTime() > from.getTime()) return candidate.getTime() - from.getTime();
  }
  return 24 * 60 * 60 * 1000;
}