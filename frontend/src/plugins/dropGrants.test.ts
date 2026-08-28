import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetDropGrantsForTest,
  issueDropGrants,
  quoteDropPath,
  redeemDropGrant,
} from "./dropGrants";

beforeEach(() => __resetDropGrantsForTest());

describe("host-issued file drop grants", () => {
  it("publishes opaque owner-bound grants and redeems each one once", () => {
    const issued = issueDropGrants({
      pluginId: "soksak-plugin-terminal-vt100",
      window: "win-a",
      paths: ["<local-evidence>/a b", "<local-evidence>/image.png"],
    });
    expect(issued).toHaveLength(2);
    expect(issued.map((grant) => grant.kind)).toEqual(["file", "image"]);
    expect(JSON.stringify(issued)).not.toContain("<local-evidence>/");
    expect(redeemDropGrant({
      pluginId: "other-plugin", window: "win-a", id: issued[0].id, loginShell: "/bin/zsh",
    })).toBeNull();
    expect(redeemDropGrant({
      pluginId: "soksak-plugin-terminal-vt100", window: "win-b", id: issued[0].id, loginShell: "/bin/zsh",
    })).toBeNull();
    expect(redeemDropGrant({
      pluginId: "soksak-plugin-terminal-vt100", window: "win-a", id: issued[0].id, loginShell: "/bin/zsh",
    })).toEqual({ kind: "file", shellText: "'<local-evidence>/a b'" });
    expect(redeemDropGrant({
      pluginId: "soksak-plugin-terminal-vt100", window: "win-a", id: issued[0].id, loginShell: "/bin/zsh",
    })).toBeNull();
  });

  it("quotes only declared shell families and refuses control characters", () => {
    expect(quoteDropPath("<local-evidence>/it's here", "/bin/zsh")).toBe("'<local-evidence>/it'\\''s here'");
    expect(quoteDropPath("C:\\A B\\file.txt", "pwsh.exe")).toBe("'C:\\A B\\file.txt'");
    expect(quoteDropPath("C:\\A B\\file.txt", "cmd.exe")).toBe('"C:\\A B\\file.txt"');
    expect(() => quoteDropPath("<local-evidence>/a\nnext", "/bin/zsh")).toThrow(/control character/);
    expect(() => quoteDropPath("<local-evidence>/a", "/bin/unknown-shell")).toThrow(/unsupported drop shell/);
  });
});
