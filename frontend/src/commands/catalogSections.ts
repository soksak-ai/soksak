// sidebar.* — the compositions, the links, and which one stands.
//
// A section is a plugin (A2a), and no plugin declares what it appears beside. These commands are how
// a person puts sections together and gives a plugin its set. Everything the settings screen can do
// is here first: a surface with no command is not shipped (C2).

import { key, tmsg } from "../i18n";
import {
  focusedPluginOf,
  standingSet,
  useSectionSets,
  type PluginPlace,
  type SectionPlace,
  type SectionSet,
} from "../state/sectionSets";
import { viewsOnSurface } from "../plugins/viewRegistry";
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
 * functions the host calls — the standing set, filtered to the views that live beside the work —
 * because a second way of deciding what stands is a second answer to one question.
 */
async function waitForPlaceToStand(place: SectionPlace, stands: SectionSet | null): Promise<void> {
  const beside = new Set(viewsOnSurface("side").map((view) => view.key));
  const wanted = (stands?.sections ?? []).filter((section) => beside.has(section)).join(" ");
  await waitForDomCommit(() => {
    const host = document.querySelector<HTMLElement>(`[data-region="${place}"] .sidebar-left`);
    // No host is a place standing nothing, which is the same as an empty declaration.
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
export function refuseUnplaced(set: SectionSet): string | null {
  // A section is a `side` view. Which place a set stands in is a different question — all three
  // places are beside the work, so a `side` view is standable in every one of them.
  const beside = new Set(viewsOnSurface("side").map((v) => v.key));
  const foreign = set.sections.filter((k) => !beside.has(k));
  if (foreign.length === 0) return null;
  return tmsg("msg.sections.notBeside", { sections: foreign.join(", ") });
}

/** A section key for an example line — one that is actually placed, and a stand-in when none is. */
function exampleSection(): string {
  return viewsOnSurface("side")[0]?.key ?? "<plugin>.<view>";
}

/** A plugin id for an example line — one that placed a section, and a stand-in when none did. */
function examplePlugin(): string {
  const key = viewsOnSurface("side")[0]?.key;
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
        sets: s.sets,
        byPlugin: s.byPlugin,
        left: s.left,
        // What there is to compose from. Without it a person putting a set together has to know the
        // section keys already, and nothing outside can name one that exists — the same list the
        // host filters by, so an offered section is one that can actually stand. One list, because
        // a `side` view is standable in any of the three places.
        available: viewsOnSurface("side").map((v) => v.key),
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
      place: { type: "string", enum: ["rail", "right"], description: key("cmd.sections.link.param.place"), required: true },
    },
    returns: "{ plugin, set, place, moved }",
    message: () => tmsg("msg.sections.link"),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: [
      `sections.link '{"plugin":"${examplePlugin()}","set":"set-a2b3c4","place":"rail"}'`,
    ],
    handler: async (p, ctx) => {
      const plugin = p.plugin as string;
      // The two places that follow the focus. `left` holds one set for the installation and is set
      // with sections.left, not linked to a plugin.
      const place = p.place as PluginPlace | undefined;
      if (place !== "rail" && place !== "right") {
        return invalid(tmsg("msg.sections.placeRequired"));
      }
      const id = p.set as string | undefined;
      if (id !== undefined) {
        const set = setOf(id);
        if (!set) return notFound(id);
        const refusal = refuseUnplaced(set);
        if (refusal) return invalid(refusal);
      }
      const focused = focusedPluginOf(resolveWorkspace(p, ctx));
      const before = standingSet(place, focused);
      useSectionSets.getState().link(plugin, place, id ?? null);
      const after = standingSet(place, focused);
      // Whether this link changed what stands here. Linking a plugin that is not focused changes
      // nothing on screen, and a caller that waits for a frame on every link waits out its own
      // timeout — the same fact tab.activate answers under the name `moved`.
      const moved = (before?.id ?? null) !== (after?.id ?? null);
      if (moved) await waitForPlaceToStand(place, after);
      return { plugin, set: id ?? null, place, moved };
    },
  });

  // The left edge holds one set for the whole installation, whatever is focused. It replaces a
  // mode switch that chose between "the focused plugin's set" and "one fixed set" for every place
  // at once: with three places, a switch lets two of them answer the same way and then there is no
  // reason for there to be two. The place is the rule now.
  register("sections.left", {
    description: key("cmd.sections.left.desc"),
    triggers: { ko: "왼쪽 사이드바 고정 전역 세트" },
    params: {
      set: { type: "string", description: key("cmd.sections.left.param.set") },
    },
    returns: "{ left }",
    message: (d) => tmsg("msg.sections.left", { set: String(d.left ?? "") }),
    errors: ["TARGET_NOT_FOUND", "INVALID_PARAMS"],
    examples: ['sections.left \'{"set":"set-a2b3c4"}\'', "sections.left"],
    handler: async (p, ctx) => {
      const id = p.set as string | undefined;
      if (id !== undefined) {
        const set = setOf(id);
        if (!set) return notFound(id);
        const refusal = refuseUnplaced(set);
        if (refusal) return invalid(refusal);
      }
      const before = standingSet("left", focusedPluginOf(resolveWorkspace(p, ctx)));
      useSectionSets.getState().standLeft(id ?? null);
      const after = standingSet("left", focusedPluginOf(resolveWorkspace(p, ctx)));
      const moved = (before?.id ?? null) !== (after?.id ?? null);
      if (moved) await waitForPlaceToStand("left", after);
      return { left: id ?? null, moved };
    },
  });
}
