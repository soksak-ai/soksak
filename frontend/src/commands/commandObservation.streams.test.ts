import { expect, it, vi } from "vitest";

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  openStreamCount: () => 7,
}));
vi.mock("../plugins/pluginModuleRealm", () => ({
  pluginModuleRealmStats: () => ({ open: 2, created: 3, disposed: 1 }),
}));
vi.mock("../plugins/pluginModuleCache", () => ({
  pluginModuleCache: {
    stats: () => ({ open: 2, loaded: 2, reused: 4, replaced: 0, released: 0 }),
  },
}));

import { commandHealth } from "./commandObservation";

it("reports the current frontend stream receiver count", () => {
  expect(commandHealth(1)).toMatchObject({
    streams: { open: 7 },
    plugins: {
      realms: { open: 2, created: 3, disposed: 1 },
      modules: { open: 2, loaded: 2, reused: 4, replaced: 0, released: 0 },
    },
  });
});
