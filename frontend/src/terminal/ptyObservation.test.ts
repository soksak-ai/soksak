import { describe, it, expect } from "vitest";
import { createPtyObservationParser } from "./ptyObservation";

// PTY observation parser contract — parses shell-integration OSC sequences (OSC 7 cwd, OSC 133/633
// command markers) straight from raw PTY output strings and bytes, with no xterm Terminal dependency.
// Regression line: if this breaks, app.terminal.* and command.* events all collapse after the core
// terminal view removal.

describe("ptyObservation — OSC 7 cwd", () => {
  it("decodes an OSC 7 file URI into a cwd", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    p.write("\x1b]7;file:///tmp/x\x07");
    expect(cwds).toEqual(["/tmp/x"]);
  });

  it("preserves a percent-encoded, non-ASCII path across the round trip", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    p.write(`\x1b]7;file://host${encodeURI("/tmp/my workspace/héllo")}\x07`);
    expect(cwds).toEqual(["/tmp/my workspace/héllo"]);
  });

  it("a repeated cwd notifies nothing; only a change does", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    p.write("\x1b]7;file:///a\x07");
    p.write("\x1b]7;file:///a\x07");
    p.write("\x1b]7;file:///b\x07");
    expect(cwds).toEqual(["/a", "/b"]);
  });

  it("getCwd exposes the snapshot", () => {
    const p = createPtyObservationParser({});
    expect(p.getCwd()).toBeUndefined();
    p.write("\x1b]7;file:///tmp/z\x07");
    expect(p.getCwd()).toBe("/tmp/z");
  });
});

describe("ptyObservation — OSC 633 markers", () => {
  it("OSC 633;E decodes the percent-encoded command line and notifies onCommandStart", () => {
    const starts: string[] = [];
    const p = createPtyObservationParser({ onCommandStart: (c) => starts.push(c) });
    p.write("\x1b]633;E;claude%20--model%20sonnet\x07");
    expect(starts).toEqual(["claude --model sonnet"]);
  });

  it("OSC 633;P;Cwd= updates the cwd", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    p.write("\x1b]633;P;Cwd=/srv/app\x07");
    expect(cwds).toEqual(["/srv/app"]);
  });

  it("OSC 633;D notifies onCommandFinished", () => {
    let finished = 0;
    const p = createPtyObservationParser({ onCommandFinished: () => finished++ });
    p.write("\x1b]633;D;0\x07");
    expect(finished).toBe(1);
  });
});

describe("ptyObservation — OSC 133 markers (standard)", () => {
  it("OSC 133;D notifies onCommandFinished", () => {
    let finished = 0;
    const p = createPtyObservationParser({ onCommandFinished: () => finished++ });
    p.write("\x1b]133;D;0\x07");
    expect(finished).toBe(1);
  });

  it("OSC 133;A (prompt start) is not a finish notification", () => {
    let finished = 0;
    const p = createPtyObservationParser({ onCommandFinished: () => finished++ });
    p.write("\x1b]133;A\x07");
    expect(finished).toBe(0);
  });

  it("an ST (ESC backslash) terminator is treated the same as BEL", () => {
    let finished = 0;
    const p = createPtyObservationParser({ onCommandFinished: () => finished++ });
    p.write("\x1b]133;D;0\x1b\\");
    expect(finished).toBe(1);
  });
});

describe("ptyObservation — chunk boundaries / mixed stream", () => {
  it("parses an OSC sequence split across chunks (streaming)", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    p.write("\x1b]7;fil");
    p.write("e:///split/path");
    p.write("\x07");
    expect(cwds).toEqual(["/split/path"]);
  });

  it("ignores ordinary output text and handles only the embedded OSC", () => {
    const cwds: string[] = [];
    const starts: string[] = [];
    const p = createPtyObservationParser({
      onCwd: (c) => cwds.push(c),
      onCommandStart: (c) => starts.push(c),
    });
    p.write("hello\x1b]633;E;ls%20-la\x07world\x1b]7;file:///d\x07more");
    expect(starts).toEqual(["ls -la"]);
    expect(cwds).toEqual(["/d"]);
  });

  it("handles Uint8Array byte input the same way (UTF-8 decode)", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    const bytes = new TextEncoder().encode("\x1b]7;file:///bytes/path\x07");
    p.write(bytes);
    expect(cwds).toEqual(["/bytes/path"]);
  });

  it("passes a non-OSC ESC (CSI and others) through safely", () => {
    const cwds: string[] = [];
    const p = createPtyObservationParser({ onCwd: (c) => cwds.push(c) });
    // CSI cursor moves then OSC 7 — CSI is ignored, only OSC is captured.
    p.write("\x1b[2J\x1b[H\x1b]7;file:///after/csi\x07");
    expect(cwds).toEqual(["/after/csi"]);
  });
});
