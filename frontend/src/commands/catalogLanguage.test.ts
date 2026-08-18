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
import { catalogJson, getSpec } from "./registry";
import { withReaderLanguage } from "../i18n";

/** Every description as it was registered: a key, or a literal nobody keyed. */
function registeredSentences(): { where: string; value: string | { i18nKey: string } }[] {
  const registered: { where: string; value: string | { i18nKey: string } }[] = [];
  for (const command of catalogJson()) {
    const spec = getSpec(command.name);
    if (!spec) continue;
    registered.push({ where: command.name, value: spec.description });
    for (const [param, declared] of Object.entries(spec.params)) {
      registered.push({ where: `${command.name}.${param}`, value: declared.description });
    }
  }
  return registered;
}

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
// It is counted from what was registered, not from what two readings have in common: a keyed
// sentence whose Korean and English are the same string — `{ kind:'at'|'every'|'cron' }` — is
// keyed, and reading it twice cannot tell it from a literal.
const unkeyedDescriptions = 0;

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
    const literals = registeredSentences()
      .filter((entry) => typeof entry.value === "string")
      .map((entry) => `${entry.where}=${entry.value as string}`);

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
          `Lower unkeyedDescriptions to ${literals.length} so the ratchet holds the new floor.\n` +
          // Named, because the next batch needs the list and reading it out of the source means
          // finding the multi-line ones by eye.
          literals.join("\n"),
      );
    }
  });
});
