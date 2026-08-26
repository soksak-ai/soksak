import { expect, it, vi } from "vitest";

vi.mock("../framework", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../framework")>()),
  openStreamCount: () => 7,
}));

import { commandHealth } from "./commandObservation";

it("reports the current frontend stream receiver count", () => {
  expect(commandHealth(1)).toMatchObject({ streams: { open: 7 } });
});
