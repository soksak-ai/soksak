import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (relative: string): string =>
  readFileSync(join(import.meta.dirname, relative), "utf8");

describe("native plugin runtime boundary", () => {
  it("never evaluates plugin bytes in the main renderer", () => {
    const loader = source("./loader.ts");
    const store = source("../state/plugins.ts");

    for (const [label, text] of [
      ["loader", loader],
      ["plugin store", store],
    ] as const) {
      expect(text, `${label}: plugin byte Blob is forbidden`).not.toMatch(
        /new\s+Blob\s*\(/,
      );
      expect(text, `${label}: plugin object URL is forbidden`).not.toContain(
        "URL.createObjectURL",
      );
      expect(text, `${label}: runtime ESM import is forbidden`).not.toMatch(
        /import\s*\(\s*\/\*\s*@vite-ignore\s*\*\//,
      );
      expect(text, `${label}: legacy import seam is forbidden`).not.toContain(
        "importPluginModule",
      );
    }
  });
});
