// sidebar.* — the compositions, the links, and which one stands.
//
// A section is a plugin (A2a), and no plugin declares what it appears beside. These commands are how
// a person puts sections together and gives a plugin its set. Everything the settings screen can do
// is here first: a surface with no command is not shipped (C2).

import { key, tmsg } from "../i18n";
import {
  focusedPluginOf,
  standingSet,
  standsSomewhere,
  useSectionSets,
  type Region,
  type SectionSet,
} from "../state/sectionSets";
import { viewsForPlacement } from "../plugins/viewRegistry";
import { resolveWorkspace } from "./catalog";
import { register } from "./registry";
import { waitForDomCommit } from "./waitForDomCommit";

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

/**
 * Waits until the region declares it is standing the set now linked to it.
 *
 * The host declares what it stands (`data-region-sections`), so this reads a declaration rather
 * than working it out from what has a rectangle. The expected value comes from the same two
 * functions the host calls — the standing set, filtered to what is placed in this region — because
 * a second way of deciding what stands is a second answer to one question.
 */
async function waitForRegionToStand(region: Region, stands: SectionSet | null): Promise<void> {
  const placed = new Set(viewsForPlacement(region).map((view) => view.key));
  const wanted = (stands?.sections ?? []).filter((section) => placed.has(section)).join(" ");
  await waitForDomCommit(() => {
    const host = document.querySelector<HTMLElement>(`[data-region="${region}"] .sidebar-left`);
    // No host is a region standing nothing, which is the same as an empty declaration.
    if (!host) return wanted === "";
    return host.dataset.regionSections === wanted;
  });
}

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
    description: key("cmd.sections.list.desc"),
    triggers: { ko: "섹션 세트 목록 조합 목록" },
    params: {},
    returns: "{ mode, fixed, sets: [{id,title,sections}], byPlugin, available: {left,right} }",
    message: (d) => tmsg("msg.sections.list", { n: ((d.sets as unknown[]) ?? []).length }),
    examples: ["sections.list"],
    handler: () => {
      const s = useSectionSets.getState();
      return {
        mode: s.mode,
        fixed: s.fixed,
        sets: s.sets,
        byPlugin: s.byPlugin,
        // What there is to compose from. Without it a person putting a set together has to know the
        // section keys already, and nothing outside can name one that exists — the same list the
        // host filters by, so an offered section is one that can actually stand.
        available: {
          left: viewsForPlacement("left").map((v) => v.key),
          right: viewsForPlacement("right").map((v) => v.key),
        },
      };
    },
  });

  register("sections.create", {
    description: key("cmd.sections.create.desc"),
    triggers: { ko: "섹션 세트 생성 조합 만들기" },
    params: { title: { type: "string", description: key("cmd.sections.create.param.title"), required: true } },
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
    description: key("cmd.sections.rename.desc"),
    triggers: { ko: "섹션 세트 이름 변경" },
    params: {
      set: { type: "string", description: key("cmd.sections.rename.param.set"), required: true },
      title: { type: "string", description: key("cmd.sections.rename.param.title"), required: true },
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
    description: key("cmd.sections.remove.desc"),
    triggers: { ko: "섹션 세트 삭제 제거" },
    params: { set: { type: "string", description: key("cmd.sections.remove.param.set"), required: true } },
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
    description: key("cmd.sections.arrange.desc"),
    triggers: { ko: "섹션 구성 순서" },
    params: {
      set: { type: "string", description: key("cmd.sections.arrange.param.set"), required: true },
      sections: { type: "json", description: key("cmd.sections.arrange.param.sections"), required: true },
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
    description: key("cmd.sections.link.desc"),
    triggers: { ko: "섹션 세트 연결 플러그인 연결" },
    params: {
      plugin: { type: "string", description: key("cmd.sections.link.param.plugin"), required: true },
      set: { type: "string", description: key("cmd.sections.link.param.set") },
      region: { type: "string", enum: ["left", "right"], description: key("cmd.sections.link.param.region"), required: true },
    },
    returns: "{ plugin, set, region }",
    message: () => tmsg("msg.sections.link"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      `sections.link '{"plugin":"${examplePlugin()}","set":"set-a2b3c4","region":"left"}'`,
    ],
    handler: async (p, ctx) => {
      const plugin = p.plugin as string;
      const region = p.region as Region | undefined;
      if (region !== "left" && region !== "right") {
        return invalid(tmsg("msg.sections.regionRequired"));
      }
      const id = p.set as string | undefined;
      if (id !== undefined) {
        const set = setOf(id);
        if (!set) return notFound(id);
        const refusal = refuseUnplaced(set, region);
        if (refusal) return invalid(refusal);
      }
      const focused = focusedPluginOf(resolveWorkspace(p, ctx));
      const before = standingSet(region, focused);
      useSectionSets.getState().link(plugin, region, id ?? null);
      const after = standingSet(region, focused);
      // Whether this link changed what stands here. Linking a plugin that is not focused changes
      // nothing on screen, and a caller that waits for a frame on every link waits out its own
      // timeout — the same fact tab.activate answers under the name `moved`.
      const moved = (before?.id ?? null) !== (after?.id ?? null);
      if (moved) await waitForRegionToStand(region, after);
      return { plugin, set: id ?? null, region, moved };
    },
  });

  register("sections.mode", {
    description: key("cmd.sections.mode.desc"),
    triggers: { ko: "섹션 모드 개별 고정" },
    params: {
      mode: { type: "string", enum: ["individual", "fixed"], description: key("cmd.sections.mode.param.mode"), required: true },
      set: { type: "string", description: key("cmd.sections.mode.param.set") },
      region: { type: "string", enum: ["left", "right"], description: key("cmd.sections.mode.param.region") },
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
        store.setFixed(region, id);
      }
      if (mode === "fixed" && !standsSomewhere(useSectionSets.getState().fixed)) {
        // Switching to fixed with nothing to stand is a mode that shows nothing and reports success.
        return invalid(tmsg("msg.sections.fixedNeedsOne"));
      }
      useSectionSets.getState().setMode(mode);
      const now = useSectionSets.getState();
      return { mode: now.mode, fixed: now.fixed };
    },
  });
}
