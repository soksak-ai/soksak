import { describe, expect, it } from "vitest";

import { chunkBudgetPlugins } from "../../vite.config";

describe("frontend chunk budget mode", () => {
  it("checks production output and permits unminified development output", () => {
    expect(chunkBudgetPlugins("production").map((plugin) => plugin.name)).toEqual([
      "enforce-chunk-budget",
    ]);
    expect(chunkBudgetPlugins("development")).toEqual([]);
  });
});
