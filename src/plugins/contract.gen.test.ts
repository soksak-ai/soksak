// 플러그인 계약 발행 + 핀 — 코어가 단일 소스로 contract.json 을 만든다. Doctor 게이트가 이걸 소비한다.
// 평소: 커밋된 contract.json 이 라이브 코어 값과 일치하는지 검증(드리프트 시 RED).
// 재생성: GEN=1 vitest 로 실행하면 현재 코어 값으로 contract.json 을 다시 쓴다(손작성 금지).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, SPEC_VERSION } from "./spec";
import { themeVarContract } from "./themeContract";

const FILE = join(process.cwd(), "src", "plugins", "contract.json");

// 명명 규칙(기계 강제 가능한 부분만): soksak-plugin- 접두 + 소문자 kebab 세그먼트. 대분류/이름 구조는
// 표준독립 도구(kanban/erd 등) 예외가 있어 기계 강제 안 함 — Doctor 는 형식 + id===디렉토리만 본다.
const ID_PATTERN = "^soksak-plugin-[a-z0-9]+(-[a-z0-9]+)*$";

function liveContract() {
  const theme = themeVarContract();
  return {
    specVersion: SPEC_VERSION,
    idPattern: ID_PATTERN,
    permissions: [...PERMISSIONS].sort(),
    themeVars: theme.vars,
    themeVocab: theme.vocab,
  };
}

describe("plugin contract.json — 코어 발행 + 핀", () => {
  it("커밋된 contract.json 은 라이브 코어 값과 일치(GEN=1 로 재생성)", () => {
    const live = liveContract();
    if (process.env.GEN || !existsSync(FILE)) {
      writeFileSync(FILE, JSON.stringify(live, null, 2) + "\n");
    }
    const onDisk = JSON.parse(readFileSync(FILE, "utf8"));
    expect(onDisk).toEqual(live); // 비면 RED: 코어 권한/테마 변경 후 contract.json 미갱신 → GEN=1 재생성
  });
});
