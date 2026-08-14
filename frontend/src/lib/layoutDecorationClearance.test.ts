import { afterEach, describe, expect, it } from "vitest";
import {
  __resetLayoutDecorationClearanceForTest,
  layoutDecorationClearanceFacts,
} from "./layoutDecorationClearance";

describe("layout decoration clearance", () => {
  afterEach(__resetLayoutDecorationClearanceForTest);

  it("the public ledger keeps renderer clearance per transaction and a bounded event identity", () => {
    expect(layoutDecorationClearanceFacts()).toEqual({ owners: [], events: [], maxEvents: 64 });
  });
});
