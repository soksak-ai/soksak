// Current 0.0.1 host UI surface declarations.
// Placement, labels, command bindings, and input eligibility are manifest data. Runtime
// code may provide an exactly-declared overlay or update host-owned display state; it never
// supplies callbacks, visibility, placement, or an imperative registration description.
import type { LocalizedText } from "./localizedText.js";
import {
  checkDuplicates,
  checkKnownKeys,
  isNonEmptyString,
  isRecord,
} from "./util.js";

export type OverlayScope = "screen" | "pane";

export interface ContributedOverlay {
  id: string;
  title: LocalizedText;
  scope: OverlayScope;
  capturesInput: boolean;
}

export interface ContributedHeaderAction {
  id: string;
  title: LocalizedText;
  icon: string;
  command: string;
}

export interface ContributedStatusItem {
  id: string;
  title: LocalizedText;
  command: string;
}

interface TextCodec {
  validate(value: unknown, label: string, errors: string[]): value is LocalizedText;
  normalize(value: LocalizedText): LocalizedText;
}

interface ParseContext {
  commandNames: ReadonlySet<string>;
  permissions: readonly string[];
  text: TextCodec;
}

export interface ParsedUiSurfaces {
  overlays: ContributedOverlay[];
  headerActions: ContributedHeaderAction[];
  statusItems: ContributedStatusItem[];
}

const SURFACE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function entries(
  raw: unknown,
  label: string,
  allowed: readonly string[],
  errors: string[],
): Record<string, unknown>[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    errors.push(`${label}: 배열이어야 함`);
    return [];
  }
  const out: Record<string, unknown>[] = [];
  raw.forEach((item, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!isRecord(item)) {
      errors.push(`${itemLabel}: 객체가 아님`);
      return;
    }
    checkKnownKeys(item, allowed, itemLabel, errors);
    out.push(item);
  });
  return out;
}

function flatId(value: unknown, label: string, errors: string[]): value is string {
  if (!isNonEmptyString(value) || !SURFACE_ID_RE.test(value)) {
    errors.push(`${label}: id 는 ^[a-z0-9][a-z0-9-]*$`);
    return false;
  }
  return true;
}

function declaredCommand(
  value: unknown,
  label: string,
  commandNames: ReadonlySet<string>,
  errors: string[],
): value is string {
  if (!isNonEmptyString(value) || !commandNames.has(value)) {
    errors.push(`${label}: 같은 contributes.commands에 선언되지 않은 커맨드 "${String(value)}"`);
    return false;
  }
  return true;
}

export function parseUiSurfaces(
  contributes: Record<string, unknown>,
  context: ParseContext,
  errors: string[],
): ParsedUiSurfaces {
  const overlays = entries(
    contributes.overlays,
    "contributes.overlays",
    ["id", "title", "scope", "capturesInput"],
    errors,
  ).flatMap((item) => {
    let valid = true;
    if (!flatId(item.id, "contributes.overlays", errors)) valid = false;
    if (!context.text.validate(item.title, "contributes.overlays.title", errors)) valid = false;
    if (item.scope !== "screen" && item.scope !== "pane") {
      errors.push('contributes.overlays.scope: "screen" | "pane"');
      valid = false;
    }
    if (typeof item.capturesInput !== "boolean") {
      errors.push("contributes.overlays.capturesInput: boolean 필수");
      valid = false;
    }
    if (!valid) return [];
    return [{
      id: item.id as string,
      title: context.text.normalize(item.title as LocalizedText),
      scope: item.scope as OverlayScope,
      capturesInput: item.capturesInput as boolean,
    }];
  });
  checkDuplicates(overlays.map((item) => item.id), "contributes.overlays.id", errors);
  for (const scope of ["screen", "pane"] as const) {
    if (
      overlays.some((overlay) => overlay.scope === scope) &&
      !context.permissions.includes(`ui:overlay:${scope}`)
    ) {
      errors.push(`contributes.overlays(scope:${scope}): "ui:overlay:${scope}" 권한 선언 필요`);
    }
  }

  const headerActions = entries(
    contributes.headerActions,
    "contributes.headerActions",
    ["id", "title", "icon", "command"],
    errors,
  ).flatMap((item) => {
    let valid = true;
    if (!flatId(item.id, "contributes.headerActions", errors)) valid = false;
    if (!context.text.validate(item.title, "contributes.headerActions.title", errors)) valid = false;
    if (!isNonEmptyString(item.icon)) {
      errors.push("contributes.headerActions.icon: 비공백 문자열 필수");
      valid = false;
    }
    if (!declaredCommand(item.command, "contributes.headerActions.command", context.commandNames, errors)) {
      valid = false;
    }
    if (!valid) return [];
    return [{
      id: item.id as string,
      title: context.text.normalize(item.title as LocalizedText),
      icon: (item.icon as string).trim(),
      command: item.command as string,
    }];
  });
  checkDuplicates(headerActions.map((item) => item.id), "contributes.headerActions.id", errors);
  if (headerActions.length > 0 && !context.permissions.includes("ui:titlebar")) {
    errors.push('contributes.headerActions: "ui:titlebar" 권한 선언 필요');
  }
  if (headerActions.length > 0 && !context.permissions.includes("commands")) {
    errors.push('contributes.headerActions: "commands" 권한 선언 필요');
  }

  const statusItems = entries(
    contributes.statusItems,
    "contributes.statusItems",
    ["id", "title", "command"],
    errors,
  ).flatMap((item) => {
    let valid = true;
    if (!flatId(item.id, "contributes.statusItems", errors)) valid = false;
    if (!context.text.validate(item.title, "contributes.statusItems.title", errors)) valid = false;
    if (!declaredCommand(item.command, "contributes.statusItems.command", context.commandNames, errors)) {
      valid = false;
    }
    if (!valid) return [];
    return [{
      id: item.id as string,
      title: context.text.normalize(item.title as LocalizedText),
      command: item.command as string,
    }];
  });
  checkDuplicates(statusItems.map((item) => item.id), "contributes.statusItems.id", errors);
  if (statusItems.length > 0 && !context.permissions.includes("ui:statusbar")) {
    errors.push('contributes.statusItems: "ui:statusbar" 권한 선언 필요');
  }
  if (statusItems.length > 0 && !context.permissions.includes("commands")) {
    errors.push('contributes.statusItems: "commands" 권한 선언 필요');
  }

  return { overlays, headerActions, statusItems };
}
