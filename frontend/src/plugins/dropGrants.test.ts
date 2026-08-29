import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetDropGrantsForTest,
  issueDropGrants,
  redeemDropGrant,
} from "./dropGrants";

beforeEach(() => __resetDropGrantsForTest());

describe("host-issued file drop grants", () => {
  it("publishes opaque owner-bound grants and redeems each one once", () => {
    const issued = issueDropGrants({
      pluginId: "soksak-plugin-terminal-vt100",
      window: "win-a",
      paths: ["/tmp/a b", "/tmp/image.png"],
    });
    expect(issued).toHaveLength(2);
    expect(issued.map((grant) => grant.kind)).toEqual(["file", "image"]);
    expect(JSON.stringify(issued)).not.toContain("/tmp/");
    expect(redeemDropGrant({
      pluginId: "other-plugin", window: "win-a", id: issued[0].id,
    })).toBeNull();
    expect(redeemDropGrant({
      pluginId: "soksak-plugin-terminal-vt100", window: "win-b", id: issued[0].id,
    })).toBeNull();
    expect(redeemDropGrant({
      pluginId: "soksak-plugin-terminal-vt100", window: "win-a", id: issued[0].id,
    })).toEqual({ kind: "file", path: "/tmp/a b" });
    expect(redeemDropGrant({
      pluginId: "soksak-plugin-terminal-vt100", window: "win-a", id: issued[0].id,
    })).toBeNull();
  });
});
