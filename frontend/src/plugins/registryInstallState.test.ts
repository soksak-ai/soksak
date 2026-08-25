import { describe, expect, it } from "vitest";
import { installState } from "./registry";

describe("registry current release install state", () => {
  it("offers update only when the current registry version is newer", () => {
    expect(installState({ version: "1.2.4" }, "1.2.3", "registry")).toBe("update");
    expect(installState({ version: "1.2.3" }, "1.2.3", "registry")).toBe("installed");
    expect(installState({ version: "1.2.2" }, "1.2.3", "registry")).toBe("installed");
  });

  it("blocks automatic managed update for a local release", () => {
    expect(installState({ version: "9.0.0" }, "1.0.0", "local")).toBe("installed");
  });
});
