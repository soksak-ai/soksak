// unit.dev.* — development source selection surface, independent of the core build identity.
// The core identity-home config is canonical; plugin kind is applied to the loader immediately
// after manifest validation.

import { invoke } from "../framework";
import { tmsg } from "../i18n";
import { usePlugins, type UnitDevSource } from "../state/plugins";
import { register } from "./registry";

const KINDS = ["plugin", "sidecar", "kit"] as const;
type UnitKind = (typeof KINDS)[number];

export function registerUnitDevCatalog(): void {
  register("unit.dev.list", {
    description:
      "List development source selections for plugins, sidecars, and kits in this CLI identity home. Core build and unit source mode are independent.",
    triggers: { ko: "유닛 개발 소스 목록 플러그인 사이드카 키트 작업공간" },
    params: {},
    // The owner produces the answer — it is the same from whichever window it runs
    // (registry.ts windowScoped).
    windowScoped: false,
    returns: "{ unitMode: official|mixed, units: Array<{kind,id,source}> }",
    message: (d) =>
      tmsg("msg.unit.dev.list", {
        mode: String(d.unitMode),
        n: ((d.units as unknown[]) ?? []).length,
      }),
    examples: ["unit.dev.list"],
    handler: async () => {
      const units = (await invoke<UnitDevSource[]>("unit_dev_list")) ?? [];
      return { unitMode: units.length === 0 ? "official" : "mixed", units };
    },
  });

  register("unit.dev.set", {
    description:
      "Select an existing absolute directory as a unit's development source in this identity home. Symlinks and relative paths are rejected. Plugin sources are validated and loaded immediately.",
    triggers: { ko: "유닛 개발 소스 지정 선택 플러그인 사이드카 키트" },
    params: {
      kind: { type: "string", enum: [...KINDS], required: true, description: "Unit kind" },
      id: { type: "string", required: true, description: "Unit id" },
      source: { type: "string", required: true, description: "Existing absolute source directory" },
    },
    returns: "{ kind, id, source }",
    message: (d) =>
      tmsg("msg.unit.dev.set", { kind: String(d.kind), id: String(d.id) }),
    errors: ["INVALID_PARAMS", "TARGET_NOT_FOUND"],
    examples: ['unit.dev.set \'{"kind":"plugin","id":"weather","source":"/absolute/path/weather"}\''],
    danger: "inject",
    handler: async (p) => {
      const kind = p.kind as UnitKind;
      const id = p.id as string;
      const source = p.source as string;
      if (kind === "plugin") {
        const loaded = await usePlugins.getState().devLoad(source, id);
        if (!loaded.ok) return loaded;
        return { kind, id, source };
      }
      try {
        return await invoke<UnitDevSource>("unit_dev_set", { kind, id, source });
      } catch (e) {
        return { ok: false, code: "INVALID_PARAMS", message: String(e) };
      }
    },
  });

  register("unit.dev.remove", {
    description:
      "Remove one development source selection without deleting its workspace. A plugin returns to its separate official installation when present.",
    triggers: { ko: "유닛 개발 소스 해제 제거 공식 설치 복귀" },
    params: {
      kind: { type: "string", enum: [...KINDS], required: true, description: "Unit kind" },
      id: { type: "string", required: true, description: "Unit id" },
    },
    returns: "{ kind, id, removed }",
    message: (d) =>
      tmsg("msg.unit.dev.remove", {
        kind: String(d.kind),
        id: String(d.id),
        state: d.removed ? "removed" : "not-selected",
      }),
    examples: ['unit.dev.remove \'{"kind":"plugin","id":"weather"}\''],
    handler: async (p) => {
      const kind = p.kind as UnitKind;
      const id = p.id as string;
      let removed: boolean;
      try {
        removed = await invoke<boolean>("unit_dev_remove", { kind, id });
      } catch (e) {
        return { ok: false, code: "INVALID_PARAMS", message: String(e) };
      }
      if (removed && kind === "plugin") await usePlugins.getState().reload();
      return { kind, id, removed };
    },
  });
}
