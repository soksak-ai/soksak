// DOM address path contract — round-trip identity, stable segments, bad input rejected. Zero selector guessing.
import { describe, expect, it } from "vitest";
import {
  formatAddress,
  isParseError,
  NODE_PATH_RE,
  parseAddress,
  type AddressParts,
} from "./address";

const ok = (s: string): AddressParts => {
  const r = parseAddress(s);
  if (isParseError(r)) throw new Error(`unexpected parse failure: ${s} → ${r.error}`);
  return r;
};

describe("parseAddress — structural decomposition", () => {
  it("full view node path", () => {
    expect(ok("win/main/proj/myproj/content/pane/0/view/soksak-plugin-acp-studio.studio/node/submit")).toEqual({
      window: "main",
      project: "myproj",
      region: "content",
      pane: "0",
      view: "soksak-plugin-acp-studio.studio",
      node: "submit",
    });
  });
  it("short form — relative to the active one (win/proj/pane omitted)", () => {
    expect(ok("content/view/soksak-plugin-mailbox.inbox/node/msg/3")).toEqual({
      region: "content",
      view: "soksak-plugin-mailbox.inbox",
      node: "msg/3",
    });
  });
  it("host chrome", () => {
    expect(ok("win/main/chrome/modal/consent/agree")).toEqual({
      window: "main",
      chrome: "modal/consent/agree",
    });
  });
  it("chrome may omit win", () => {
    expect(ok("chrome/tab/content/c1")).toEqual({ chrome: "tab/content/c1" });
  });
  it("pane active", () => {
    expect(ok("content/pane/active/view/x.y/node/n").pane).toBe("active");
  });
  it("leading and trailing slash normalization", () => {
    expect(ok("/content/view/a.b/node/n/")).toEqual({
      region: "content",
      view: "a.b",
      node: "n",
    });
  });
});

describe("round-trip identity — parse∘format", () => {
  const cases = [
    "win/main/proj/p/content/pane/0/view/a.b/node/submit",
    "content/view/x.y/node/msg/3",
    "win/w2/chrome/modal/consent/agree",
    "chrome/tab/left/files",
    "left/view/soksak-plugin-memo.panel/node/save",
  ];
  for (const c of cases) {
    it(`format(parse("${c}")) === "${c}"`, () => {
      expect(formatAddress(ok(c))).toBe(c);
    });
  }
});

describe("bad input — an explicit error (zero guessing)", () => {
  const bad = [
    "",
    "   ",
    "win", // no label
    "win/main", // no path after the window
    "content/region/middle", // a region typo is an unknown segment
    "content/pane/x", // pane is neither idx nor active
    "content/view/noplugin", // no dot in the view key
    "content/node/", // no node path
    "win/BAD UPPER/content", // uppercase or space in the label
    "content/view/a.b/node/Bad", // uppercase in the node path
  ];
  for (const b of bad) {
    it(`reject: "${b}"`, () => {
      expect(isParseError(parseAddress(b))).toBe(true);
    });
  }
});

describe("NODE_PATH_RE — node path form", () => {
  it("valid", () => {
    expect(NODE_PATH_RE.test("submit")).toBe(true);
    expect(NODE_PATH_RE.test("msg/3")).toBe(true);
    expect(NODE_PATH_RE.test("a.b/c-d/e9")).toBe(true);
  });
  it("invalid", () => {
    expect(NODE_PATH_RE.test("Submit")).toBe(false); // uppercase
    expect(NODE_PATH_RE.test("/leading")).toBe(false);
    expect(NODE_PATH_RE.test("a//b")).toBe(false);
    expect(NODE_PATH_RE.test("a b")).toBe(false);
  });
});

describe("multi-window — the win segment namespace", () => {
  it("a different window is a different address", () => {
    const a = ok("win/main/content/view/x.y/node/n");
    const b = ok("win/w2/content/view/x.y/node/n");
    expect(a.window).toBe("main");
    expect(b.window).toBe("w2");
    expect(formatAddress(a)).not.toBe(formatAddress(b));
  });
});
