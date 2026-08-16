// sidebar.* — the compositions, the links, and which one stands.
//
// A section is a plugin (A2a), and no plugin declares what it appears beside. These commands are how
// a person puts sections together and gives a plugin its set. Everything the settings screen can do
// is here first: a surface with no command is not shipped (C2).

import { tmsg } from "../i18n";
import {
  useSectionSets,
  type Region,
  type SectionSet,
  type Standing,
} from "../state/sectionSets";
import { viewsForPlacement } from "../plugins/viewRegistry";
import { register } from "./registry";

const notFound = (id: string) => ({
  ok: false as const,
  code: "TARGET_NOT_FOUND" as const,
  message: tmsg("msg.sections.notFound", { id }),
});

const invalid = (message: string) => ({
  ok: false as const,
  code: "INVALID_PARAMS" as const,
  message,
});

const setOf = (id: string): SectionSet | undefined =>
  useSectionSets.getState().sets.find((s) => s.id === id);

/** A set stands in a region only when every section it holds is placed there. Checked where the
 *  region is settled — the link, or the fixed choice — because the set names no region itself.
 *  Refused by name rather than dropped: a section that vanished silently reads as the plugin
 *  failing. */
export function refuseUnplaced(set: SectionSet, region: Region): string | null {
  const placed = new Set(viewsForPlacement(region).map((v) => v.key));
  const foreign = set.sections.filter((k) => !placed.has(k));
  if (foreign.length === 0) return null;
  return tmsg("msg.sections.notInRegion", { sections: foreign.join(", "), region });
}

/** A section key for an example line — one that is actually placed, and a stand-in when none is. */
function exampleSection(): string {
  return viewsForPlacement("left")[0]?.key ?? "<plugin>.<view>";
}

/** A plugin id for an example line — one that placed a section, and a stand-in when none did. */
function examplePlugin(): string {
  const key = viewsForPlacement("left")[0]?.key;
  return key ? key.slice(0, key.lastIndexOf(".")) : "<plugin>";
}

export function registerSectionsCatalog(): void {
  register("sections.list", {
    description:
      "The section sets this installation holds, where each plugin's set stands, the mode, and the fixed one. A set is a named, ordered list of sections; a section is a view a plugin placed in a region.",
    triggers: { ko: "섹션 세트 목록 조합 목록" },
    params: {},
    returns: "{ mode, fixed, sets: [{id,title,sections}], byPlugin }",
    message: (d) => tmsg("msg.sections.list", { n: ((d.sets as unknown[]) ?? []).length }),
    examples: ["sections.list"],
    handler: () => {
      const s = useSectionSets.getState();
      return { mode: s.mode, fixed: s.fixed, sets: s.sets, byPlugin: s.byPlugin };
    },
  });

  register("sections.create", {
    description:
      "Create an empty section set — put sections in it with sections.arrange, and stand it in a region with sections.link.",
    triggers: { ko: "섹션 세트 생성 조합 만들기" },
    params: { title: { type: "string", description: "Display name", required: true } },
    returns: "{ id, title }",
    message: () => tmsg("msg.sections.create"),
    errors: ["INVALID_PARAMS"],
    examples: ['sections.create \'{"title":"work"}\''],
    handler: (p) => {
      const title = (p.title as string).trim();
      if (!title) return invalid(tmsg("msg.sections.titleRequired"));
      const made = useSectionSets.getState().create(title);
      return { id: made.id, title: made.title };
    },
  });

  register("sections.rename", {
    description:
      "Rename a set — the id does not change, so every link to it and the fixed choice hold.",
    triggers: { ko: "섹션 세트 이름 변경" },
    params: {
      set: { type: "string", description: "Set id", required: true },
      title: { type: "string", description: "New display name", required: true },
    },
    returns: "{ id, title }",
    message: () => tmsg("msg.sections.rename"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['sections.rename \'{"set":"set-a2b3c4","title":"reading"}\''],
    handler: (p) => {
      const id = p.set as string;
      if (!setOf(id)) return notFound(id);
      const title = (p.title as string).trim();
      if (!title) return invalid(tmsg("msg.sections.titleRequired"));
      useSectionSets.getState().rename(id, title);
      return { id, title };
    },
  });

  register("sections.remove", {
    description:
      "Remove a set. Every link to it goes with it, and the fixed choice clears when it was the one — a link naming nothing reads as linked while nothing stands.",
    triggers: { ko: "섹션 세트 삭제 제거" },
    params: { set: { type: "string", description: "Set id", required: true } },
    returns: "{ id }",
    message: () => tmsg("msg.sections.remove"),
    errors: ["TARGET_NOT_FOUND"],
    examples: ['sections.remove \'{"set":"set-a2b3c4"}\''],
    handler: (p) => {
      const id = p.set as string;
      if (!setOf(id)) return notFound(id);
      useSectionSets.getState().remove(id);
      return { id };
    },
  });

  register("sections.arrange", {
    description:
      "Set what a section set holds, in the order the sections stand. A section is a view key, <pluginId>.<viewId>. Whether they can stand in a region is settled when the set is linked there.",
    triggers: { ko: "섹션 구성 순서" },
    params: {
      set: { type: "string", description: "Set id", required: true },
      sections: { type: "json", description: "View keys in order", required: true },
    },
    returns: "{ id, sections }",
    message: (d) => tmsg("msg.sections.arrange", { n: ((d.sections as unknown[]) ?? []).length }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    // The example reads the registry: a written plugin id would be the core naming one (C1).
    examples: [`sections.arrange '{"set":"set-a2b3c4","sections":["${exampleSection()}"]}'`],
    handler: (p) => {
      const id = p.set as string;
      if (!setOf(id)) return notFound(id);
      const raw = p.sections;
      if (!Array.isArray(raw) || raw.some((k) => typeof k !== "string")) {
        return invalid(tmsg("msg.sections.arrangeArray"));
      }
      const sections = raw as string[];
      useSectionSets.getState().arrange(id, sections);
      return { id, sections };
    },
  });

  register("sections.link", {
    description:
      "Stand a plugin's set in a region, or clear it by omitting set. In individual mode that set stands while a view of that plugin is focused, and a plugin with no link has no sidebar at all.",
    triggers: { ko: "섹션 세트 연결 플러그인 연결" },
    params: {
      plugin: { type: "string", description: "Plugin id", required: true },
      set: { type: "string", description: "Set id (omit = clear)" },
      region: { type: "string", enum: ["left", "right"], description: "Where it stands" },
    },
    returns: "{ plugin, set, region }",
    message: () => tmsg("msg.sections.link"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      `sections.link '{"plugin":"${examplePlugin()}","set":"set-a2b3c4","region":"left"}'`,
    ],
    handler: (p) => {
      const plugin = p.plugin as string;
      const id = p.set as string | undefined;
      if (id === undefined) {
        useSectionSets.getState().link(plugin, null);
        return { plugin, set: null, region: null };
      }
      const set = setOf(id);
      if (!set) return notFound(id);
      const region = p.region as Region | undefined;
      if (region !== "left" && region !== "right") {
        return invalid(tmsg("msg.sections.regionRequired"));
      }
      const refusal = refuseUnplaced(set, region);
      if (refusal) return invalid(refusal);
      const standing: Standing = { set: id, region };
      useSectionSets.getState().link(plugin, standing);
      return { plugin, set: id, region };
    },
  });

  register("sections.mode", {
    description:
      "individual = the set linked to the focused view's plugin stands, and nothing stands for a plugin with no link. fixed = one set stands in every workspace, whatever is focused, and links are not read.",
    triggers: { ko: "섹션 모드 개별 고정" },
    params: {
      mode: { type: "string", enum: ["individual", "fixed"], description: "Which rule decides", required: true },
      set: { type: "string", description: "The set that stands in fixed" },
      region: { type: "string", enum: ["left", "right"], description: "Where the fixed set stands" },
    },
    returns: "{ mode, fixed }",
    message: (d) => tmsg("msg.sections.mode", { mode: String(d.mode) }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['sections.mode \'{"mode":"fixed","set":"set-a2b3c4","region":"left"}\''],
    handler: (p) => {
      const mode = p.mode as "individual" | "fixed";
      const store = useSectionSets.getState();
      const id = p.set as string | undefined;
      const region = p.region as Region | undefined;
      if (id !== undefined) {
        const set = setOf(id);
        if (!set) return notFound(id);
        if (region !== "left" && region !== "right") {
          return invalid(tmsg("msg.sections.regionRequired"));
        }
        const refusal = refuseUnplaced(set, region);
        if (refusal) return invalid(refusal);
        store.setFixed({ set: id, region });
      }
      if (mode === "fixed" && useSectionSets.getState().fixed === null) {
        // Switching to fixed with nothing to stand is a mode that shows nothing and reports success.
        return invalid(tmsg("msg.sections.fixedNeedsOne"));
      }
      useSectionSets.getState().setMode(mode);
      const now = useSectionSets.getState();
      return { mode: now.mode, fixed: now.fixed };
    },
  });
}
