// Contract for identity vocabulary judgment — a morpheme rule, so variants are not missed (the hole in the
// exact-match banned list was a real incident: removing data-pane-id left the data-panel and data-divider
// families behind and the contamination continued).
import { describe, expect, it } from "vitest";
import { bannedDomName, domNameTokens, externalDomOwner } from "./identityVocabulary";

describe("identityVocabulary — banned-word morpheme judgment", () => {
  it("catches variants too — hyphen or camel spelling alike", () => {
    for (const bad of [
      "data-panel",
      "data-panel-id",
      "my-divider-line",
      "eGroupHost",
      "tabSlot",
      "cellBody",
      "grid-area",
      "bodywrap",
    ]) {
      expect(bannedDomName(bad), bad).not.toBeNull();
    }
  });

  it("canonical words and substring look-alikes pass — the unit is the morpheme, so there is no false positive", () => {
    for (const good of [
      "data-pane",
      "data-tab-id",
      "pane-gutter",
      "data-gutter",
      "space-body",
      "grouping-x", // "grouping", not the "group" token — the morpheme does not match
      "cellar", // not "cell"
    ]) {
      expect(bannedDomName(good), good).toBeNull();
    }
  });

  it("tokenization splits the boundaries exactly", () => {
    expect(domNameTokens("data-paneId")).toEqual(["data", "pane", "id"]);
    expect(domNameTokens("eGroupHost")).toEqual(["e", "group", "host"]);
  });

  it("an externally owned name is out of this judgment — renaming it is not ours to do", () => {
    // Real evidence (2026-07-27 plugin census): plugins using Tailwind, cmdk, or shadcn have these names as
    // literals in their source — banning them makes that whole ecosystem unusable.
    for (const ext of ["grid", "grid-cols-2", "grid-rows-4", "group", "group-hover", "cmdk-group", "cmdk-group-heading", "data-slot"]) {
      expect(externalDomOwner(ext), ext).not.toBeNull();
      expect(bannedDomName(ext), ext).toBeNull();
    }
  });

  it("the external-owner table is an ownership record, not an exemption desk — our own compound names are still caught", () => {
    // grid-cols-N is Tailwind syntax; names of our own such as truncate-grid and canvas-frame are not.
    for (const bad of ["data-truncate-grid", "canvas-frame", "grid-cols-x", "grid-area", "my-group", "cmdkGroup", "data-slot-id"]) {
      expect(externalDomOwner(bad), bad).toBeNull();
      expect(bannedDomName(bad), bad).not.toBeNull();
    }
  });
});
