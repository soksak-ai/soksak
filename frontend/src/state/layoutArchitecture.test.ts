import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("split-pane layout architecture", () => {
  const sourceRoot = resolve(import.meta.dirname, "..");

  it("does not retain the legacy tree or tolerance-based line repair", () => {
    const forbidden = ["state/splitTree", "state/verticalLines"];
    const files = [
      "components/GroupArea.tsx",
      "components/SectionSetHost.tsx",
      "state/sessions.ts",
      "state/windowSnapshot.ts",
      "commands/catalog.ts",
    ];
    const references = files.flatMap((file) => {
      const source = readFileSync(resolve(sourceRoot, file), "utf8");
      return forbidden.filter((name) => source.includes(name));
    });
    expect(references, "legacy layout ownership must be removed").toEqual([]);
  });

  it("passes split-pane coordinates without a second unit system", () => {
    const source = readFileSync(resolve(sourceRoot, "components/SplitPaneCardHost.tsx"), "utf8");
    expect(source).toContain("const toLibraryState = <T,>(layout: SplitPaneCardLayout<T>): SplitPaneState => layout;");
    expect(source).not.toContain("value / 100");
    expect(source).not.toContain("value * 100");
  });
});
