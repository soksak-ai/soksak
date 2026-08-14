import { describe, expect, it } from "vitest";
import { mergeLayoutStagedTargets } from "./layoutStagedTargets";

describe("mergeLayoutStagedTargets", () => {
  it("merges the same native target from every participant into one transaction identity", () => {
    expect(mergeLayoutStagedTargets([
      { id: "native-content", stagedTargets: ["pane:p-left", "direct:v-terminal"] },
      { id: "projection", stagedTargets: ["pane:p-left", "pane:p-right"] },
      { id: "settlement", stagedTargets: ["pane:p-right"] },
    ])).toEqual([
      "pane:p-left",
      "direct:v-terminal",
      "pane:p-right",
    ]);
  });
});
