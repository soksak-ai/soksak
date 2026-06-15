import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// [규칙 강제] 브라우저 webview label 은 webviewLabels.ts(browserLabel) 단일 진실에서만 파생한다.
// inline `b-${...}` 로 흩어 정의하면 창 네임스페이스가 빠져 멀티 윈도우에서 label 이 충돌한다
// (둘째 창 브라우저 미생성·좀비). 이 테스트가 그 회귀를 빌드로 막는다 — MW1·capability 가드와 동궤.

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("webview label 단일 진실", () => {
  it("inline `b-${...}` 브라우저 label 구성 금지(webviewLabels 밖)", () => {
    const offenders: string[] = [];
    for (const f of walk("src")) {
      if (f.endsWith("webviewLabels.ts")) continue; // 단일 진실 본인
      if (f.endsWith("webviewLabels.test.ts")) continue; // 이 패턴을 문자열로 언급
      const src = readFileSync(f, "utf8");
      if (/`b-\$\{/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
