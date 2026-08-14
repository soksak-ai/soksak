// Deep link contract — command URI parse/build round trip plus activation (permission and danger gates stay on = remote:true).
import { describe, expect, it } from "vitest";
import { buildDeepLink, parseDeepLink, resolveDeepLink } from "./deepLink";

describe("parseDeepLink", () => {
  it("soksak://cmd/<command> → {command, params}", () => {
    expect(parseDeepLink("soksak://cmd/git.log")).toEqual({ command: "git.log", params: {} });
  });

  it("query values: number and bool are parsed, a string stays a string", () => {
    expect(
      parseDeepLink("soksak://cmd/mailbox.open?id=m1&n=5&flag=true"),
    ).toEqual({ command: "mailbox.open", params: { id: "m1", n: 5, flag: true } });
  });

  it("a shape mismatch is null — protocol, host, empty command", () => {
    expect(parseDeepLink("http://x/y")).toBeNull();
    expect(parseDeepLink("soksak://other/x")).toBeNull();
    expect(parseDeepLink("soksak://cmd/")).toBeNull();
    expect(parseDeepLink("not a url")).toBeNull();
  });
});

describe("buildDeepLink ↔ parseDeepLink round trip", () => {
  it("parsing a built URL gives the same values, with types preserved", () => {
    const url = buildDeepLink("mailbox.open", { id: "m1", project: "projA", n: 2 });
    expect(url).toBe("soksak://cmd/mailbox.open?id=m1&project=projA&n=2");
    expect(parseDeepLink(url)).toEqual({
      command: "mailbox.open",
      params: { id: "m1", project: "projA", n: 2 },
    });
  });

  it("null and undefined values are left out", () => {
    expect(buildDeepLink("c", { a: "x", b: null, c: undefined })).toBe("soksak://cmd/c?a=x");
  });
});

describe("resolveDeepLink", () => {
  it("a valid link activates first, then runs the command with the remote:true gate", async () => {
    const calls: unknown[] = [];
    const out = await resolveDeepLink("soksak://cmd/mailbox.open?id=m1&project=projA", {
      execute: async (name, params, ctx) => {
        calls.push({ name, params, ctx });
        return { ok: true, code: "OK", message: "ok" };
      },
      activate: async () => {
        calls.push("activate");
      },
    });
    expect(out.ok).toBe(true);
    expect(calls[0]).toBe("activate"); // the app is activated before the run
    expect(calls[1]).toEqual({
      name: "mailbox.open",
      params: { id: "m1", project: "projA" },
      ctx: { remote: true },
    });
  });

  it("an invalid link is INVALID_PARAMS and runs nothing", async () => {
    let executed = false;
    const out = await resolveDeepLink("http://nope", {
      execute: async () => {
        executed = true;
        return { ok: true, code: "OK", message: "ok" };
      },
      activate: async () => {},
    });
    expect(out.ok).toBe(false);
    expect(executed).toBe(false);
  });
});
