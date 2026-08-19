import type { MsgKey } from "../i18n";

export const SECURITY_BACKEND_LABEL: Record<string, MsgKey> = {
  keychain: "settings.security.kind.keychain",
  wincred: "settings.security.kind.wincred",
  libsecret: "settings.security.kind.secretService",
  e2e: "settings.security.kind.e2e",
  none: "settings.security.kind.none",
};

const SECURITY_LIMIT_KEY: Record<string, MsgKey> = {
  keychain: "settings.security.limits.macos",
  wincred: "settings.security.limits.windows",
  libsecret: "settings.security.limits.linux",
  e2e: "settings.security.limits.test",
  none: "settings.security.limits.unavailable",
};

export function securityLimitKey(backend: string): MsgKey {
  return SECURITY_LIMIT_KEY[backend] ?? "settings.security.limits.unknown";
}
