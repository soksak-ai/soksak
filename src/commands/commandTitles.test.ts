// 명령 라벨 커버리지 게이트 — 코어 전 명령은 언어 테이블에 cmd.<이름> 라벨을 가진다.
// 활동 피드 버블이 raw 키 대신 이 라벨(아나운서체)을 렌더한다(OrchestratorApp.commandLabel).
// 구조: 라벨은 언어 테이블 1장/언어(번역자는 테이블만, 정의 자리는 불변 — 언어 추가 = 테이블 추가).
// 이 게이트가 있어 "일부 명령만 라벨" 상태로는 커밋이 통과하지 못한다.
// 플러그인 명령 라벨은 각 매니페스트 contributes.commands[].title 소유 — 이 게이트 대상 아님.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasMessage } from "../i18n";

function coreCommandNames(): string[] {
  const dir = join(__dirname);
  const names = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!/^catalog.*\.ts$/.test(f) || f.includes(".test.")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/register\("([^"]+)"/g)) names.add(m[1]);
  }
  return [...names].sort();
}

describe("명령 라벨 커버리지 (cmd.* 게이트)", () => {
  it("모든 코어 명령이 언어 테이블에 라벨을 가진다", () => {
    const missing = coreCommandNames().filter((n) => !hasMessage(`cmd.${n}`));
    expect(missing).toEqual([]);
  });
});
