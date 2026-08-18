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
import { key, text, withReaderLanguage, type Sentence } from "../i18n";

/** Every description as it was registered: a key, or a literal nobody keyed. */
function registeredSentences(): { where: string; value: Sentence }[] {
  const registered: { where: string; value: Sentence }[] = [];
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

describe("a plugin's own sentences", () => {
  // A plugin has no key in this build's table and never will: it ships on its own schedule and the
  // host never promised it a key. Its text travels as a language map instead, and the host resolves
  // it against whoever asked — the same edge, the same reader, one mechanism away.
  //
  // Measured 2026-08-18, before this: a plugin command's description was a plain English literal
  // and its answer went through the plugin's own `app.locale()`, which read the window's setting.
  // A `sok` caller reading English through a Korean window was answered in Korean.
  const declared = {
    en: "Load a page in this pane's browser surface.",
    ko: "이 판의 브라우저 표면에 페이지를 엽니다.",
  };

  it("a language map is resolved against the reader, not the window", () => {
    expect(withReaderLanguage("en", () => text(declared))).toBe(declared.en);
    expect(withReaderLanguage("ko", () => text(declared))).toBe(declared.ko);
  });

  it("a language a plugin does not carry falls back rather than answering blank", () => {
    const englishOnly = { en: "Only English here" };
    expect(withReaderLanguage("ko", () => text(englishOnly))).toBe("Only English here");
  });

  it("a plain string stands for every language", () => {
    expect(withReaderLanguage("ko", () => text("one string"))).toBe("one string");
    expect(withReaderLanguage("en", () => text("one string"))).toBe("one string");
  });

  it("a key and a language map are told apart by shape, never by guessing", () => {
    // `i18nKey` is not a language key — a language key is two letters and an optional subtag — so a
    // plugin's map can never be read as a key by accident.
    const asKey = withReaderLanguage("ko", () => text(key("cmd.state.tree.desc")));
    const asMap = withReaderLanguage("ko", () => text({ i18nKeyLike: "cmd.state.tree.desc" }));
    expect(asKey).not.toBe("cmd.state.tree.desc");
    expect(asMap).toBe("cmd.state.tree.desc");
  });
});
