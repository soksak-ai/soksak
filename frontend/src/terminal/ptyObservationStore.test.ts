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
    registerPtyObservation("p1");
    const seen: string[] = [];
    subscribeObservedCwd("p1", (c) => seen.push(c));
    feedPtyOutput("p1", "\x1b]7;file://<local-evidence>/work\x07");
    expect(getObservedCwd("p1")).toBe("<local-evidence>/work");
    expect(seen).toEqual(["<local-evidence>/work"]);
  });

  it("a subscription with a current value notifies once immediately (no polling)", () => {
    registerPtyObservation("p1");
    feedPtyOutput("p1", "\x1b]7;file:///a\x07");
    const seen: string[] = [];
    subscribeObservedCwd("p1", (c) => seen.push(c));
    expect(seen).toEqual(["/a"]);
  });

  it("command start (633;E) — global subscribers get paneId, command line and cwd, plus a runningCommands snapshot", () => {
    registerPtyObservation("p1");
    feedPtyOutput("p1", "\x1b]633;P;Cwd=/proj\x07");
    const starts: { paneId: string; cmd: string; cwd: string | null }[] = [];
    subscribeAnyCommandStarted((paneId, cmd, cwd) =>
      starts.push({ paneId, cmd, cwd }),
    );
    feedPtyOutput("p1", "\x1b]633;E;npm%20test\x07");
    expect(starts).toEqual([{ paneId: "p1", cmd: "npm test", cwd: "/proj" }]);
    expect(observedRunningCommands()).toEqual([
      { paneId: "p1", commandLine: "npm test", cwd: "/proj" },
    ]);
  });

  it("command finish (133;D) — the pane subscription and the global subscription (with the finished command line and cwd), and runningCommands clears", () => {
    registerPtyObservation("p1");
    feedPtyOutput("p1", "\x1b]633;P;Cwd=/proj\x07");
    feedPtyOutput("p1", "\x1b]633;E;build\x07");
    let tabFinished = 0;
    subscribeObservedCommandFinished("p1", () => tabFinished++);
    const fins: {
      paneId: string;
      cmd: string | null | undefined;
      cwd: string | null | undefined;
    }[] = [];
    subscribeAnyCommandFinished((paneId, cmd, cwd) =>
      fins.push({ paneId, cmd, cwd }),
    );
    feedPtyOutput("p1", "\x1b]133;D;0\x07");
    expect(tabFinished).toBe(1);
    expect(fins).toEqual([{ paneId: "p1", cmd: "build", cwd: "/proj" }]);
    expect(observedRunningCommands()).toEqual([]);
  });

  it("output notifies the output subscribers (live stream, for input verification)", () => {
    registerPtyObservation("p1");
    let n = 0;
    subscribeObservedOutput("p1", () => n++);
    feedPtyOutput("p1", "some output\n");
    feedPtyOutput("p1", "more\n");
    expect(n).toBe(2);
  });

  it("after dispose there is no notification and the cwd snapshot is gone (leak blocked)", () => {
    registerPtyObservation("p1");
    feedPtyOutput("p1", "\x1b]7;file:///x\x07");
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
    expect(hasPtyObservation("p1")).toBe(false);
    registerPtyObservation("p1");
    expect(hasPtyObservation("p1")).toBe(true);
    expect(hasPtyObservation("p2")).toBe(false);
    disposePtyObservation("p1");
    expect(hasPtyObservation("p1")).toBe(false);
  });

// PTY IO handler registration (GAP2) — a pty-driver (core host or plugin terminal) registers
// readBuffer/sendInput keyed by paneId. app.terminal.readBuffer/sendText prefer these.
  it("IO registered with registerPtyIo is read back with getPtyIo and reclaimed on dispose", () => {
    expect(getPtyIo("p1")).toBeUndefined();
    const reads: (number | undefined)[] = [];
    const sends: string[] = [];
    const off = registerPtyIo("p1", {
      readBuffer: (lines) => {
        reads.push(lines);
        return "buffer-text";
      },
      sendInput: (data) => {
        sends.push(data);
      },
    });
    const io = getPtyIo("p1");
    expect(io?.readBuffer(5)).toBe("buffer-text");
    expect(reads).toEqual([5]);
    io?.sendInput("ls\r");
    expect(sends).toEqual(["ls\r"]);
    off();
    expect(getPtyIo("p1")).toBeUndefined();
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
