// A command catalogue answers whoever is reading it.
//
// The catalogue is registered once, at boot, and read afterwards by every caller: a window drawing
// a palette, a `sok` invocation, an agent asking what exists. A description built at registration
// is the sentence for whoever booted the window, and it stays that one for every caller after.
//
// Measured 2026-08-18, before this test existed: `state.tree` answered one identical string to a
// Korean reader and an English one, and so did all 448 parameter descriptions. Deferring the
// sentence (I18nKey, resolved in catalogJson) is what makes the same registration answer two
// readers differently.
import { beforeAll, describe, expect, it } from "vitest";
import { registerCatalog } from "./catalog";
import { catalogJson } from "./registry";
import { withReaderLanguage } from "../i18n";

/** Every description the catalogue shows, in one flat list, read as one language. */
function sentencesIn(language: "ko" | "en"): string[] {
  return withReaderLanguage(language, () =>
    catalogJson().flatMap((command) => [
      `${command.name}=${command.description}`,
      ...Object.entries(command.params ?? {}).map(
        ([param, spec]) => `${command.name}.${param}=${String(spec.description)}`,
      ),
    ]),
  );
}

// unkeyedDescriptions is how many of the catalogue's sentences are still literals somebody wrote
// in English rather than keys. It only goes down. Lower it when a batch lands; the failure names
// the new floor.
//
// It is not zero yet and the number is the honest size of that: a literal reads correct to whoever
// wrote it, because whoever wrote it reads English (I18N.md I1).
//
// A keyed sentence whose two translations happen to be identical counts here too. That overcounts
// and never undercounts, which is the direction a ratchet can absorb.
const unkeyedDescriptions = 168;

describe("the catalogue in the reader's language", () => {
  beforeAll(() => {
    registerCatalog();
  });

  it("a keyed sentence differs between a Korean reader and an English one", () => {
    const ko = sentencesIn("ko");
    const en = sentencesIn("en");
    expect(ko, "the two readings must line up entry for entry").toHaveLength(en.length);

    const keyed = ko.filter((sentence, index) => sentence !== en[index]);
    expect(
      keyed.length,
      "no sentence changed with the reader — the catalogue is answering in the language it booted in",
    ).toBeGreaterThan(0);
  });

  it("the sentences still written as literals are counted, and the count only falls", () => {
    const ko = sentencesIn("ko");
    const en = sentencesIn("en");
    const literals = ko.filter((sentence, index) => sentence === en[index]);

    if (literals.length > unkeyedDescriptions) {
      expect.fail(
        `${literals.length} catalogue sentences are hardcoded, over the floor of ${unkeyedDescriptions}. ` +
          `A new one arrived:\n${literals.slice(0, 12).join("\n")}\n` +
          "Declare it in i18n.ko.ts and i18n.en.ts and register it with key().",
      );
    }
    if (literals.length < unkeyedDescriptions) {
      expect.fail(
        `${literals.length} hardcoded sentences remain, below the floor of ${unkeyedDescriptions}. ` +
          `Lower unkeyedDescriptions to ${literals.length} so the ratchet holds the new floor.`,
      );
    }
  });
});
