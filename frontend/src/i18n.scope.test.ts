// A command answers in the language of whoever asked, not the language the window is set to.
//
// Measured 2026-08-16: an English sok call was answered TARGET_NOT_FOUND with its sentence in
// Korean. The window rendered its own display language because nothing had told it otherwise, and
// the caller received a sentence they cannot read.
//
// The scope is synchronous on purpose. The answer — message, speak, hint — is assembled in one
// unbroken stretch, so a module-level current language is safe there. A handler that awaits is not
// covered, which is why a refusal holds its key instead of a finished sentence.
import { describe, expect, it } from "vitest";

import { tmsg, withReaderLanguage } from "./i18n";
import { useSettings } from "./state/settings";

describe("the language a sentence is built in", () => {
  it("outside a scope, the window's own setting decides", () => {
    useSettings.setState({ language: "ko" });
    expect(tmsg("msg.workspace.notFound")).toBe(tmsg("msg.workspace.notFound"));
    const inKorean = tmsg("msg.workspace.notFound");
    useSettings.setState({ language: "en" });
    expect(tmsg("msg.workspace.notFound")).not.toBe(inKorean);
  });

  it("inside a scope, the reader's language decides", () => {
    useSettings.setState({ language: "ko" });
    const asked = withReaderLanguage("en", () => tmsg("msg.workspace.notFound"));
    useSettings.setState({ language: "en" });
    expect(asked).toBe(tmsg("msg.workspace.notFound"));
  });

  it("a scope of nothing leaves the window's setting alone", () => {
    // A caller who named no language is not a caller asking for English. Overriding on their
    // behalf would have every unlabelled call quietly change what a window answers.
    useSettings.setState({ language: "ko" });
    const inKorean = tmsg("msg.workspace.notFound");
    expect(withReaderLanguage(null, () => tmsg("msg.workspace.notFound"))).toBe(inKorean);
  });

  it("the scope is restored even when the work throws", () => {
    useSettings.setState({ language: "ko" });
    const inKorean = tmsg("msg.workspace.notFound");
    expect(() => withReaderLanguage("en", () => { throw new Error("the answer failed"); })).toThrow();
    expect(tmsg("msg.workspace.notFound")).toBe(inKorean);
  });

  it("scopes nest, and the inner one wins for its own stretch", () => {
    useSettings.setState({ language: "ko" });
    const inKorean = tmsg("msg.workspace.notFound");
    const seen = withReaderLanguage("en", () => [
      tmsg("msg.workspace.notFound"),
      withReaderLanguage("ko", () => tmsg("msg.workspace.notFound")),
      tmsg("msg.workspace.notFound"),
    ]);
    expect(seen[1]).toBe(inKorean);
    expect(seen[0]).toBe(seen[2]);
    expect(seen[0]).not.toBe(inKorean);
  });

  it("a language this build does not serve leaves the window's setting alone", () => {
    useSettings.setState({ language: "ko" });
    const inKorean = tmsg("msg.workspace.notFound");
    expect(withReaderLanguage("fr", () => tmsg("msg.workspace.notFound"))).toBe(inKorean);
  });
});
