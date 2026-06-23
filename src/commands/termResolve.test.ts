// term.* pane 해석 — 코어 터미널 호스트 우선, 없으면 PTY substrate(플러그인 터미널) 폴백.
// 단일 해석 경로(resolveTermPane): 코어 host-div 또는 substrate(getPtyIo/getObservedCwd)로
// 같은 paneId 에 닿는다. 플러그인 터미널(view.open program=terminal → kind=plugin, paneId=viewId)이
// term.read/send/exec/cwd 로 도달 가능해야 한다(TARGET_NOT_FOUND 금지).
import { beforeEach, describe, expect, it, vi } from "vitest";

// catalog import 가 settings(localStorage) 를 건드릴 수 있어 stub 먼저.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
});

import { resolveTermPane } from "./termResolve";
import {
  registerPtyIo,
  pushObservedCwd,
  resetPtyObservationStoreForTest,
} from "../terminal/ptyObservationStore";

beforeEach(() => {
  resetPtyObservationStoreForTest();
});

describe("resolveTermPane — 코어 호스트 없는 플러그인 터미널은 substrate 로 해석", () => {
  it("substrate 에만 IO 가 등록된 pane(=플러그인 터미널 viewId) 도 valid + read/send/cwd 도달", () => {
    const reads: (number | undefined)[] = [];
    const sends: string[] = [];
    registerPtyIo("v37", {
      readBuffer: (lines) => {
        reads.push(lines);
        return "PLUGIN_BUFFER";
      },
      sendInput: (data) => void sends.push(data),
    });
    pushObservedCwd("v37", "/tmp/plug");

    // 명시 pane="v37" — 코어 호스트엔 없지만 substrate 에 있다.
    const r = resolveTermPane({ pane: "v37" }, {});
    expect(r).not.toBeNull();
    expect(r!.paneId).toBe("v37");

    // read 는 substrate IO 로.
    expect(r!.readBuffer(50)).toBe("PLUGIN_BUFFER");
    expect(reads).toEqual([50]);

    // send 는 substrate IO 로(true).
    expect(r!.sendInput("echo hi\r")).toBe(true);
    expect(sends).toEqual(["echo hi\r"]);

    // cwd 는 substrate 관찰에서.
    expect(r!.getCwd()).toBe("/tmp/plug");
  });

  it("어디에도 없는 pane 은 null(TARGET_NOT_FOUND 원천)", () => {
    expect(resolveTermPane({ pane: "ghost" }, {})).toBeNull();
  });

  it("substrate 관찰만 있고 IO 미등록이면: valid 하지만 read/send 는 준비 안 됨(undefined/false)", () => {
    pushObservedCwd("v99", "/tmp/x"); // pushObservedCwd 는 관찰 미존재면 no-op 이므로 먼저 등록 필요.
    // 관찰 자체가 없으면 valid 가 아님 — IO 도 cwd 도 없는 순수 ghost 와 구분하기 위해 registerPtyIo 로
    // 관찰을 만들고 즉시 해지하는 대신, 여기선 registerPtyIo 후 IO 만 비워 검증한다.
    const dispose = registerPtyIo("v99", {
      readBuffer: () => "X",
      sendInput: () => {},
    });
    dispose(); // IO 해지 → 관찰(hasPtyObservation)은 남는다.
    const r = resolveTermPane({ pane: "v99" }, {});
    expect(r).not.toBeNull();
    expect(r!.readBuffer()).toBeUndefined();
    expect(r!.sendInput("x")).toBe(false);
  });
});
