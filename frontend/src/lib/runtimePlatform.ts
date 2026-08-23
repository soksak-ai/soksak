export type PlatformKey = "darwin" | "linux" | "win32";

export function detectPlatform(
  platform = navigator.platform,
  userAgent = navigator.userAgent,
): PlatformKey {
  const identity = `${platform} ${userAgent}`.toLowerCase();
  if (identity.includes("mac")) return "darwin";
  if (identity.includes("win")) return "win32";
  return "linux";
}
