export const SIGNALDECK_TIME_ZONE = "America/Chicago";

const clockOptions = {
  timeZone: SIGNALDECK_TIME_ZONE,
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
} as const;

const clock = new Intl.DateTimeFormat("en-US", clockOptions);
const calendarClock = new Intl.DateTimeFormat("en-US", {
  ...clockOptions,
  month: "short",
  day: "numeric",
  year: "numeric",
});

export function formatCentralTime(value: string | number | Date) {
  return clock.format(new Date(value));
}

export function formatCentralDateTime(value: string | number | Date) {
  return calendarClock.format(new Date(value));
}
