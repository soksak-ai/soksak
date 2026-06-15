// @ts-nocheck — 대상은 vanilla 플러그인(plugins/soksak-plugin-claude-gui/main.js). tsc 는 건너뛰고
// vitest(esbuild)로만 실행한다. named export(pickActiveSession)는 로더가 무시
// (loader.ts:38 default 만 사용)하므로 플러그인 동작 불변 — 테스트 전용 노출.
//
// 재현 RED → 구현 → GREEN. /resume 세션 동기화 버그: GUI 가 활성 세션을 못 따라감.
// 근본 원인 = 감지 신호를 오염된 session-env(codex companion·서브에이전트·헤드리스로 난립,
// mtime 이 resume 에 갱신 안 됨)로 잡음. 올바른 신호 = 프로젝트 dir 에서 활발히 append 되는
// jsonl(newest mtime). pickActiveSession 이 그 선택 정책을 담당한다.

import { describe, it, expect } from "vitest";
import { pickActiveSession } from "../../plugins/soksak-plugin-claude-gui/main.js";

// fs.list 의 children 형태: { name, dir(bool), modified(unix sec) }.
const jsonl = (uuid, modified) => ({ name: `${uuid}.jsonl`, dir: false, modified });
const A = "9fde0561-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "e5ba3cc7-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cfcd41ac-cccc-4ccc-8ccc-cccccccccccc";

describe("pickActiveSession — 활성 세션 = newest mtime jsonl", () => {
  it("가장 최근 수정된 jsonl 의 세션을 고른다", () => {
    const children = [jsonl(A, 100), jsonl(B, 300), jsonl(C, 200)];
    expect(pickActiveSession(children, 0)).toBe(B);
  });

  it("resume 재현: 초기 non-newest 세션이 newest 가 되면 그 세션으로 바뀐다", () => {
    // 초기: A 가 활성(newest). 사용자가 /resume 로 B 선택 → B 에 append → B 가 newest.
    const before = [jsonl(A, 500), jsonl(B, 100)];
    expect(pickActiveSession(before, 0)).toBe(A);
    const afterResume = [jsonl(A, 500), jsonl(B, 900)]; // B 갱신(append)
    expect(pickActiveSession(afterResume, 0)).toBe(B);
  });

  it("since 필터: 그 시각 이전 수정 파일은 후보에서 제외(startup stale 방지)", () => {
    const children = [jsonl(A, 100), jsonl(B, 300)];
    // since=200 → A(100) 제외, B(300)만 후보.
    expect(pickActiveSession(children, 200)).toBe(B);
  });

  it("since 이후 갱신된 옛 세션은 다시 후보가 된다(resume 한 오래된 세션)", () => {
    // A 는 오래 전 세션이지만 resume+append 로 mtime 이 since 를 넘으면 선택돼야 한다.
    const children = [jsonl(A, 950), jsonl(B, 400)];
    expect(pickActiveSession(children, 900)).toBe(A);
  });

  it("디렉토리·비-jsonl·비-UUID 파일은 무시한다", () => {
    const children = [
      { name: "subdir", dir: true, modified: 999 },
      { name: "notes.txt", dir: false, modified: 998 },
      { name: "summary.json", dir: false, modified: 997 },
      { name: "short.jsonl", dir: false, modified: 996 }, // UUID 아님
      jsonl(A, 100),
    ];
    expect(pickActiveSession(children, 0)).toBe(A);
  });

  it("후보 jsonl 이 없으면 null", () => {
    expect(pickActiveSession([], 0)).toBeNull();
    expect(pickActiveSession([{ name: "x.txt", dir: false, modified: 5 }], 0)).toBeNull();
    expect(pickActiveSession([jsonl(A, 50)], 100)).toBeNull(); // since 로 전부 배제
  });

  it("children 이 비정상(null/undefined)이어도 throw 하지 않고 null", () => {
    expect(pickActiveSession(null, 0)).toBeNull();
    expect(pickActiveSession(undefined, 0)).toBeNull();
  });
});
