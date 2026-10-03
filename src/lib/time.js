// Wall-clock helpers that work in the user's timezone regardless of the server's (Railway runs UTC).

function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, Number(p.value)]));
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

// Offset (ms) of timeZone from UTC at the given instant, e.g. -5h for America/Chicago in summer.
function tzOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

// The instant when the wall clock in timeZone reads year-month-day hour:minute.
function zonedTimeToUtc({ year, month, day, hour, minute }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let instant = guess - tzOffsetMs(new Date(guess), timeZone);
  // Re-check once in case the guess and the answer straddle a DST change.
  instant = guess - tzOffsetMs(new Date(instant), timeZone);
  return new Date(instant);
}

// Next time strictly after `now` that the clock in timeZone reads hhmm ("08:30").
export function nextLocalTime(hhmm, timeZone, now = new Date()) {
  const [hour, minute] = hhmm.split(':').map(Number);
  const today = zonedParts(now, timeZone);
  const candidate = zonedTimeToUtc({ ...today, hour, minute }, timeZone);
  if (candidate > now) return candidate;
  // Tomorrow's calendar date in timeZone (noon UTC of today's local date + 1 day is safely inside it).
  const tomorrow = zonedParts(new Date(Date.UTC(today.year, today.month - 1, today.day + 1, 12)), 'UTC');
  return zonedTimeToUtc({ ...tomorrow, hour, minute }, timeZone);
}
