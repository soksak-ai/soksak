import { describe, it, expect, beforeEach } from "vitest";
import {
  feedPtyOutput,
  registerPtyObservation,
  disposePtyObservation,
  hasPtyObservation,
  registerPtyIo,
  getPtyIo,
  getObservedCwd,
  subscribeObservedCwd,
  subscribeObservedCommandFinished,
  subscribeObservedOutput,
  subscribeAnyCommandStarted,
  subscribeAnyCommandFinished,
  observedRunningCommands,
  pushObservedCwd,
  pushObservedCommandStart,
  pushObservedCommandFinished,
  pushObservedOutput,
  resetPtyObservationStoreForTest,
} from "./ptyObservationStore";

// PTY observation store contract — collects cwd/command/output observations keyed by paneId (string). A PTY
// substrate (whoever drives app.pty) feeds output into feedPtyOutput; OSC is parsed and pushed to subscribers.
// app.terminal.* + command.* events + idle/status read this store, including after the core terminal view removal.

describe("ptyObservationStore", () => {
  beforeEach(() => resetPtyObservationStoreForTest());

  it("feeding OSC 7 output updates that paneId's cwd and notifies subscribers", () => {
    registerPtyObservation("pan-aaaaaa");
    const seen: string[] = [];
    subscribeObservedCwd("pan-aaaaaa", (c) => seen.push(c));
    feedPtyOutput("pan-aaaaaa", "\x1b]7;file:///tmp/work\x07");
    expect(getObservedCwd("pan-aaaaaa")).toBe("/tmp/work");
    expect(seen).toEqual(["/tmp/work"]);
  });

  it("a subscription with a current value notifies once immediately (no polling)", () => {
    registerPtyObservation("pan-aaaaaa");
    feedPtyOutput("pan-aaaaaa", "\x1b]7;file:///a\x07");
    const seen: string[] = [];
    subscribeObservedCwd("pan-aaaaaa", (c) => seen.push(c));
    expect(seen).toEqual(["/a"]);
  });

  it("command start (633;E) — global subscribers get paneId, command line and cwd, plus a runningCommands snapshot", () => {
    registerPtyObservation("pan-aaaaaa");
    feedPtyOutput("pan-aaaaaa", "\x1b]633;P;Cwd=/proj\x07");
    const starts: { paneId: string; cmd: string; cwd: string | null }[] = [];
    subscribeAnyCommandStarted((paneId, cmd, cwd) =>
      starts.push({ paneId, cmd, cwd }),
    );
    feedPtyOutput("pan-aaaaaa", "\x1b]633;E;npm%20test\x07");
    expect(starts).toEqual([{ paneId: "pan-aaaaaa", cmd: "npm test", cwd: "/proj" }]);
    expect(observedRunningCommands()).toEqual([
      { paneId: "pan-aaaaaa", commandLine: "npm test", cwd: "/proj" },
    ]);
  });

  it("command finish (133;D) — the pane subscription and the global subscription (with the finished command line and cwd), and runningCommands clears", () => {
    registerPtyObservation("pan-aaaaaa");
    feedPtyOutput("pan-aaaaaa", "\x1b]633;P;Cwd=/proj\x07");
    feedPtyOutput("pan-aaaaaa", "\x1b]633;E;build\x07");
    let tabFinished = 0;
    subscribeObservedCommandFinished("pan-aaaaaa", () => tabFinished++);
    const fins: {
      paneId: string;
      cmd: string | null | undefined;
      cwd: string | null | undefined;
    }[] = [];
    subscribeAnyCommandFinished((paneId, cmd, cwd) =>
      fins.push({ paneId, cmd, cwd }),
    );
    feedPtyOutput("pan-aaaaaa", "\x1b]133;D;0\x07");
    expect(tabFinished).toBe(1);
    expect(fins).toEqual([{ paneId: "pan-aaaaaa", cmd: "build", cwd: "/proj" }]);
    expect(observedRunningCommands()).toEqual([]);
  });

  it("output notifies the output subscribers (live stream, for input verification)", () => {
    registerPtyObservation("pan-aaaaaa");
    let n = 0;
    subscribeObservedOutput("pan-aaaaaa", () => n++);
    feedPtyOutput("pan-aaaaaa", "some output\n");
    feedPtyOutput("pan-aaaaaa", "more\n");
    expect(n).toBe(2);
  });

  it("after dispose there is no notification and the cwd snapshot is gone (leak blocked)", () => {
    registerPtyObservation("pan-aaaaaa");
    feedPtyOutput("pan-aaaaaa", "\x1b]7;file:///x\x07");
    let n = 0;
    subscribeObservedCwd("pan-aaaaaa", () => n++);
    disposePtyObservation("pan-aaaaaa");
    feedPtyOutput("pan-aaaaaa", "\x1b]7;file:///y\x07"); // after dispose — ignored
    expect(getObservedCwd("pan-aaaaaa")).toBeUndefined();
    expect(n).toBe(1); // only the one immediate notification at subscribe time (current value /x)
  });

  it("two panes are independent of each other (key isolation)", () => {
    registerPtyObservation("a");
    registerPtyObservation("b");
    feedPtyOutput("a", "\x1b]7;file:///a-dir\x07");
    feedPtyOutput("b", "\x1b]7;file:///b-dir\x07");
    expect(getObservedCwd("a")).toBe("/a-dir");
    expect(getObservedCwd("b")).toBe("/b-dir");
  });

  it("feeding an unregistered paneId is safe (no-op)", () => {
    expect(() => feedPtyOutput("ghost", "\x1b]7;file:///g\x07")).not.toThrow();
    expect(getObservedCwd("ghost")).toBeUndefined();
  });

// hasPtyObservation = does this id drive a PTY substrate (generic terminal signal, independent of
// pluginId). File tree cwdTabOf uses it to follow core and plugin terminals without distinguishing them.
  it("hasPtyObservation is true only for a registered paneId, and false after dispose", () => {
    expect(hasPtyObservation("pan-aaaaaa")).toBe(false);
    registerPtyObservation("pan-aaaaaa");
    expect(hasPtyObservation("pan-aaaaaa")).toBe(true);
    expect(hasPtyObservation("p2")).toBe(false);
    disposePtyObservation("pan-aaaaaa");
    expect(hasPtyObservation("pan-aaaaaa")).toBe(false);
  });

// PTY IO handler registration (GAP2) — a pty-driver (core host or plugin terminal) registers
// readBuffer/sendInput keyed by paneId. app.terminal.readBuffer/sendText prefer these.
  it("IO registered with registerPtyIo is read back with getPtyIo and reclaimed on dispose", () => {
    expect(getPtyIo("pan-aaaaaa")).toBeUndefined();
    const reads: (number | undefined)[] = [];
    const sends: string[] = [];
    const off = registerPtyIo("pan-aaaaaa", {
      readBuffer: (lines) => {
        reads.push(lines);
        return "buffer-text";
      },
      sendInput: (data) => {
        sends.push(data);
      },
    });
    const io = getPtyIo("pan-aaaaaa");
    expect(io?.readBuffer(5)).toBe("buffer-text");
    expect(reads).toEqual([5]);
    io?.sendInput("ls\r");
    expect(sends).toEqual(["ls\r"]);
    off();
    expect(getPtyIo("pan-aaaaaa")).toBeUndefined();
  });

  it("registerPtyIo registers on its own with no prior observation (no pre-registration needed) and keeps keys isolated", () => {
    registerPtyIo("a", { readBuffer: () => "A", sendInput: () => {} });
    registerPtyIo("b", { readBuffer: () => "B", sendInput: () => {} });
    expect(getPtyIo("a")?.readBuffer()).toBe("A");
    expect(getPtyIo("b")?.readBuffer()).toBe("B");
    disposePtyObservation("a");
    expect(getPtyIo("a")).toBeUndefined();
    expect(getPtyIo("b")?.readBuffer()).toBe("B");
  });

// Core terminal view producer path — pushes already parsed observations directly, without reparsing raw output.
  it("the push* path feeds the same store subscribers (core producer)", () => {
    registerPtyObservation("core");
    const cwds: string[] = [];
    subscribeObservedCwd("core", (c) => cwds.push(c));
    const starts: string[] = [];
    subscribeAnyCommandStarted((_p, cmd) => starts.push(cmd));
    let tabFin = 0;
    subscribeObservedCommandFinished("core", () => tabFin++);
    const fins: (string | null | undefined)[] = [];
    subscribeAnyCommandFinished((_p, cmd) => {
      fins.push(cmd);
    });
    let out = 0;
    subscribeObservedOutput("core", () => out++);

    pushObservedCwd("core", "/core/dir");
    pushObservedCommandStart("core", "make build");
    pushObservedOutput("core");
    pushObservedCommandFinished("core");

    expect(cwds).toEqual(["/core/dir"]);
    expect(getObservedCwd("core")).toBe("/core/dir");
    expect(starts).toEqual(["make build"]);
    expect(out).toBe(1);
    expect(tabFin).toBe(1);
    expect(fins).toEqual(["make build"]);
    expect(observedRunningCommands()).toEqual([]);
  });
});
