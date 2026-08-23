import { describe, expect, it } from "vitest";
import { installState } from "./registry";

describe("registry current release install state", () => {
  it("offers update only when the current registry version is newer", () => {
    expect(installState({ version: "1.2.4" }, "1.2.3", "installed")).toBe("update");
    expect(installState({ version: "1.2.3" }, "1.2.3", "installed")).toBe("installed");
    expect(installState({ version: "1.2.2" }, "1.2.3", "installed")).toBe("installed");
  });

  it("blocks managed update for a development source", () => {
    expect(installState({ version: "9.0.0" }, "1.0.0", "dev")).toBe("installed");
  });
});
