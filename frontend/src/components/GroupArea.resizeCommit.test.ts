import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("divider landing geometry", () => {
  it("marks every preview write for immediate geometry before the store changes", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "GroupArea.tsx"),
      "utf8",
    );

    expect(source).toMatch(
      /const commitResize = rafThrottle\(\(moves: LineMove\[\]\) => \{\s*resizeGeometryPending\.current = true;\s*resizeSplits\(projectId, moves\);\s*\}\)/,
    );
    expect(source).toMatch(
      /rectMotion\.flush\(replaceGeometry \|\| resizeGeometryPending\.current \? "replace" : "animate"\);\s*resizeGeometryPending\.current = false;/,
    );
  });

  it("commits the final preview and its command while resize motion is still active", () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "GroupArea.tsx"),
      "utf8",
    );
    const start = source.indexOf("const onUp = () =>");
    const onUp = source.slice(start, source.indexOf("window.addEventListener(\"mousemove\"", start));

    expect(onUp).toMatch(
      /commitDomLayout\(\(\) => \{\s*commitResize\.flush\(\);\s*gesture\.end\(\);\s*\}\);/,
    );
    expect(onUp.indexOf("gesture.end()"), "the resize phase ended before its command reached the DOM").toBeLessThan(
      onUp.indexOf("ms.resizeDragActive = false"),
    );
  });
});
