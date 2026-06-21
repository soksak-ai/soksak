// 권한 backing 불변식 — 선언된 모든 PluginPermission 은 실제 강제 지점이 있어야 한다.
// 코어 기능이 플러그인으로 빠지면(예: 에디터 추출 → app.editor 제거) 그 권한은 "죽은 권한"이 되는데,
// 기존 테스트는 이를 못 잡았다. 이 테스트가 그 부정합을 기계적으로 RED 로 잡는다(양방향):
//   (A) 죽은 권한: PERMISSIONS 에 있는데 어떤 강제 지점에도 없음 → 제거되어야 함.
//   (B) 미선언 권한: api.ts 가 게이트하는데 PERMISSIONS 에 없음 → 추가되어야 함.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PERMISSIONS, type PluginPermission } from "./spec";

const apiSrc = readFileSync(join(process.cwd(), "src", "plugins", "api.ts"), "utf8");

// api.ts 가 실제 app.* surface 를 게이트하는 권한 — has("perm") 호출에서 추출(런타임 capability 의 단일 증거).
function apiGatedPermissions(): Set<string> {
  const set = new Set<string>();
  for (const m of apiSrc.matchAll(/has\("([a-z:]+)"\)/g)) set.add(m[1]);
  return set;
}

// api.ts has() 게이트가 없지만 정당한 권한(강제 지점이 api.ts 가 아닌 곳):
//   - programs: loader 가 contributes.programs 를 선언적으로 자동 등록(api.ts 명령형 표면 없음 §2.6)
//   - commands:destructive / commands:inject: executeGated 가 명령 danger 등급으로 매핑(has 아님)
// 이 allowlist 에 넣을 땐 "왜 api.ts 게이트가 없는지" 근거가 있어야 한다(임의 추가 금지).
const NON_API_GATED: ReadonlySet<PluginPermission> = new Set([
  "programs",
  "commands:destructive",
  "commands:inject",
]);

describe("권한 backing 불변식 (코어→플러그인 추출 후 죽은 권한 차단)", () => {
  it("(A) 모든 선언 권한은 api.ts surface 게이트 또는 명시 선언형이다 — 죽은 권한 0", () => {
    const gated = apiGatedPermissions();
    const dead = PERMISSIONS.filter((p) => !gated.has(p) && !NON_API_GATED.has(p));
    expect(dead).toEqual([]); // 비면 RED: backing 없는 죽은 권한(예: app.editor 제거 후의 "editor")
  });

  it("(B) api.ts 가 게이트하는 권한은 모두 PERMISSIONS 에 선언돼 있다 — 미선언 0", () => {
    const declared = new Set<string>(PERMISSIONS);
    const undeclared = [...apiGatedPermissions()].filter((p) => !declared.has(p));
    expect(undeclared).toEqual([]); // 비면 RED: api 가 쓰는데 spec 에 없는 권한
  });

  it("NON_API_GATED allowlist 의 권한은 실제 PERMISSIONS 에 존재한다(오타·유령 방지)", () => {
    const declared = new Set<string>(PERMISSIONS);
    for (const p of NON_API_GATED) expect(declared.has(p)).toBe(true);
  });
});
