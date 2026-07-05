// 명령 답변(message) 커버리지 게이트 — 코어 전 명령은 자기 답을 안다(MESSAGE-PROTOCOL §3).
// 추측 계층(autoMessage)·code 에코 폴백을 제거했으므로, message 를 짓는 msg.<이름> 키가 언어
// 테이블에 없으면 답이 열화한다. 이 게이트가 "일부 명령만 답" 상태의 커밋을 막는다.
//   G1 = 모든 코어 명령이 base 키 msg.<이름> 을 가진다(변형 키 msg.<이름>.<변형> 은 추가 허용).
//   G2 = ko/en 키 집합이 동일하다(P0 언어 패리티 — 한쪽에만 있는 키 = 미번역, 커밋 차단).
// message 함수 필수 자체는 타입(CommandSpec.message)이 tsc 로 강제한다 — 여기는 콘텐츠 커버리지.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasMessage, langKeySets } from "../i18n";

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

describe("명령 답변 커버리지 (msg.* 게이트)", () => {
  it("G1 모든 코어 명령이 base 답변 키 msg.<이름> 을 가진다", () => {
    const missing = coreCommandNames().filter((n) => !hasMessage(`msg.${n}`));
    expect(missing).toEqual([]);
  });

  it("G2 ko/en 키 집합이 동일하다(P0 언어 패리티)", () => {
    const { ko, en } = langKeySets();
    const onlyKo = ko.filter((k) => !en.includes(k));
    const onlyEn = en.filter((k) => !ko.includes(k));
    expect({ onlyKo, onlyEn }).toEqual({ onlyKo: [], onlyEn: [] });
  });
});
