import { describe, expect, it } from "vitest";
import { parseProcfile, removeEntry, upsertEntry } from "./procfile";

// Procfile round-trip contract — preserve comments, blank lines, and order; keep the standard format (no non-standard extensions).

describe("parseProcfile", () => {
  it("parses standard lines and ignores comments and blank lines", () => {
    const t = "# dev stack\ndev: npm run dev\n\ndb: docker compose up postgres\n";
    expect(parseProcfile(t)).toEqual([
      { name: "dev", cmd: "npm run dev" },
      { name: "db", cmd: "docker compose up postgres" },
    ]);
  });

  it("the last declaration wins when a name repeats", () => {
    const t = "dev: old\ndev: new\n";
    expect(parseProcfile(t)).toEqual([{ name: "dev", cmd: "new" }]);
  });

  it("preserves a colon inside cmd (a URL, for example)", () => {
    const t = "web: node server.js --origin http://localhost:3000\n";
    expect(parseProcfile(t)[0].cmd).toBe("node server.js --origin http://localhost:3000");
  });

  it("a malformed line is not an entry", () => {
    expect(parseProcfile("malformed line\n:no-name\n")).toEqual([]);
  });
});

describe("upsertEntry", () => {
  it("appends at the end when absent — comments and existing lines preserved", () => {
    const t = "# stack\ndev: npm run dev\n";
    expect(upsertEntry(t, "db", "docker compose up")).toBe(
      "# stack\ndev: npm run dev\ndb: docker compose up\n",
    );
  });

  it("replaces in place when present (order kept)", () => {
    const t = "a: one\nb: two\nc: three\n";
    expect(upsertEntry(t, "b", "TWO")).toBe("a: one\nb: TWO\nc: three\n");
  });

  it("starts from empty text", () => {
    expect(upsertEntry("", "dev", "npm run dev")).toBe("dev: npm run dev\n");
  });

  it("throws on a malformed name", () => {
    expect(() => upsertEntry("", "bad name", "x")).toThrow();
  });
});

describe("removeEntry", () => {
  it("removes only that declaration and preserves the rest", () => {
    const t = "# keep\na: one\nb: two\n";
    expect(removeEntry(t, "a")).toEqual({ text: "# keep\nb: two\n", removed: true });
  });

  it("absent name returns the text unchanged with removed=false", () => {
    const t = "a: one\n";
    expect(removeEntry(t, "zz")).toEqual({ text: t, removed: false });
  });
});
