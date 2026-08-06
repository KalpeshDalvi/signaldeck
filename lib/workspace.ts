export const DEFAULT_WORKSPACE_ID = process.env.SIGNALDECK_WORKSPACE_ID ?? "billpay";

export function workspaceId(value?: string | null) {
  const normalized = value?.trim();
  return normalized || DEFAULT_WORKSPACE_ID;
}
