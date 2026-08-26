import { expect, it, vi } from "vitest";

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  openStreamCount: () => 7,
}));
vi.mock("../plugins/pluginModuleRealm", () => ({
  pluginModuleRealmStats: () => ({
    open: 2,
    created: 3,
    disposed: 1,
    frames: { created: 2, idle: 0, retired: 1, reused: 1 },
  }),
}));

import { commandHealth } from "./commandObservation";

it("reports the current frontend stream receiver count", () => {
  expect(commandHealth(1)).toMatchObject({
    streams: { open: 7 },
    plugins: {
      realms: {
        open: 2,
        created: 3,
        disposed: 1,
        frames: { created: 2, idle: 0, retired: 1, reused: 1 },
      },
    },
  });
});
