export const SIGNALDECK_TIME_ZONE = "America/Chicago";

export function formatCentralTime(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: SIGNALDECK_TIME_ZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

export function formatCentralDateTime(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: SIGNALDECK_TIME_ZONE,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}
