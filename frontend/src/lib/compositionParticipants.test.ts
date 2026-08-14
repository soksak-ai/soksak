// @vitest-environment jsdom
// Composition participant declaration — the core defines the shape and the framework stamps it.
//
// The three ledgers (slot, carrier, surface) must be enumerated separately, or a missing surface stays
// hidden behind the paired result. The topology path is the only link joining the three to one view,
// so exactly one place builds that path.
import { describe, expect, it } from "vitest";
import {
  COMPOSITION_KIND_ATTR,
  clearCompositionParticipant,
  compositionOwnerViewId,
  compositionParticipantSelector,
  contentCompositionTopologyPath,
  declareCompositionParticipant,
  readCompositionParticipant,
  setCompositionParticipantVisible,
} from "./compositionParticipants";

describe("composition participant declaration", () => {
  it("participants of one view hold a single phase address — there is one place that builds it", () => {
    expect(contentCompositionTopologyPath("w-1", "v-7", "b-w-1-v-7"))
      .toBe("window/w-1/view/v-7/content/b-w-1-v-7");
    // A separator inside a value does not split the path.
    expect(contentCompositionTopologyPath("w/1", "v 7", "b/1"))
      .toBe("window/w%2F1/view/v%207/content/b%2F1");
  });

  it("stamps a declaration and reads it back unchanged", () => {
    const el = document.createElement("div");
    declareCompositionParticipant(el, {
      kind: "slot",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: true,
    });
    expect(el.getAttribute(COMPOSITION_KIND_ATTR)).toBe("slot");
    expect(readCompositionParticipant(el)).toEqual({
      kind: "slot",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: true,
    });
    expect(el.matches(compositionParticipantSelector("slot"))).toBe(true);
    expect(el.matches(compositionParticipantSelector("renderer"))).toBe(false);
  });

  it("is not a participant when any axis is empty — an unreadable state is not answered as half a declaration", () => {
    const bare = document.createElement("div");
    expect(readCompositionParticipant(bare)).toBeNull();
    const half = document.createElement("div");
    half.setAttribute(COMPOSITION_KIND_ATTR, "slot");
    half.dataset.viewId = "v-7";
    expect(readCompositionParticipant(half)).toBeNull();
    const unknownKind = document.createElement("div");
    declareCompositionParticipant(unknownKind, {
      kind: "slot",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: true,
    });
    unknownKind.setAttribute(COMPOSITION_KIND_ATTR, "surface");
    expect(readCompositionParticipant(unknownKind)).toBeNull();
  });

  it("updates visibility only — the identity axes stay as they are", () => {
    const el = document.createElement("div");
    declareCompositionParticipant(el, {
      kind: "renderer",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: true,
    });
    setCompositionParticipantVisible(el, false);
    expect(readCompositionParticipant(el)).toEqual({
      kind: "renderer",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: false,
    });
  });

  it("is not a participant once the declaration is withdrawn — no dead participant stays in the ledger", () => {
    const el = document.createElement("div");
    declareCompositionParticipant(el, {
      kind: "slot",
      viewId: "v-7",
      topologyPath: "window/w-1/view/v-7/content/b-1",
      visible: true,
    });
    clearCompositionParticipant(el);
    expect(readCompositionParticipant(el)).toBeNull();
    expect(el.hasAttribute(COMPOSITION_KIND_ATTR)).toBe(false);
  });

  it("reads the owning view from the public anchor — never inferred from the label", () => {
    const host = document.createElement("div");
    host.dataset.tabId = "v-7";
    const slot = document.createElement("div");
    host.appendChild(slot);
    document.body.appendChild(host);
    expect(compositionOwnerViewId(slot)).toBe("v-7");

    const loose = document.createElement("div");
    document.body.appendChild(loose);
    expect(compositionOwnerViewId(loose)).toBeNull();
  });
});
