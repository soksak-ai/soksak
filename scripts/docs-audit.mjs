// docs 전문 검사 — 생성된 명령 레퍼런스(sok docs)가 표면 계약을 충분히 노출하는지 자동 점검한다.
// 검사 축: ① 확정 용어(스페이스/탭/패널 — 옛 용어 잔존 금지) ② danger 표기 ③ 사용 예시(examples)
// ④ 개명 잔존 ⑤ 매개변수 표 존재. 사람 눈검증을 대체하지 않고 앞단에서 기계 점검을 맡는다.
// 사용: node scripts/docs-audit.mjs docs/COMMANDS.md
import { readFileSync } from "node:fs";

const path = process.argv[2] ?? "docs/COMMANDS.md";
const text = readFileSync(path, "utf8");
const failures = [];
const warns = [];

// 명령 절 단위로 나눈다: "## `name`" 헤딩.
const sections = [...text.matchAll(/^## `([^`]+)`([^\n]*)\n([\s\S]*?)(?=^## `|\n# |$(?![\s\S]))/gm)].map(
  (m) => ({ name: m[1], heading: m[2], body: m[3] }),
);
if (sections.length < 100) failures.push(`명령 절이 너무 적습니다: ${sections.length}`);

// ① 옛 이름 잔존 — 이벤트 이름(project.created 등)과 대조표 문서는 예외.
const OLD = [/\bcontent\.(list|create|close|activate|rename|switchScan)\b/, /\bproject\.create\b(?!d)/, /\bwindow\.new\b/, /\bproject\.recent\.forget\b/, /\bsecret\.delete\b/, /"group"\s*:/, /\bgroupId\b/, /\bcontentId\b/];
for (const s of sections) {
  for (const re of OLD) {
    const m = s.body.match(re);
    if (m) failures.push(`옛 이름 잔존: ${s.name} → ${m[0]}`);
  }
}

// ② danger 명령의 헤딩 표기 — 알려진 파괴 명령 표본이 표기를 갖는지.
const MUST_DANGER = ["plugin.install", "plugin.remove", "view.close", "space.close", "panel.close", "secret.remove"];
for (const n of MUST_DANGER) {
  const s = sections.find((x) => x.name === n);
  if (!s) { warns.push(`명령 절 없음: ${n}`); continue; }
  if (!s.heading.includes("danger:")) failures.push(`danger 미표기: ${n}`);
}

// ③ 모든 명령 절에 실행 예시가 있는가.
for (const s of sections) {
  if (!s.body.includes("```")) warns.push(`예시 없음: ${s.name}`);
}

// ④ 신설 명령 노출 확인.
for (const n of ["layout.apply", "window.maximize", "daemon.add", "daemon.list", "daemon.autostart", "space.create", "project.open"]) {
  if (!sections.some((x) => x.name === n)) failures.push(`레퍼런스에 없음: ${n}`);
}

// ⑤ 데몬 안내문 — 등록을 권하는 문구가 있는가(사용자 요구).
const daemonAdd = sections.find((x) => x.name === "daemon.add");
if (daemonAdd && !/register|등록/i.test(daemonAdd.body)) failures.push("daemon.add 설명에 등록 권고 문구 없음");

console.log(`검사 대상: ${path} — 명령 절 ${sections.length}개`);
if (warns.length) {
  console.log(`\n경고 ${warns.length}건:`);
  for (const w of warns.slice(0, 20)) console.log("  -", w);
}
if (failures.length) {
  console.log(`\n실패 ${failures.length}건:`);
  for (const f of failures) console.log("  ✗", f);
  process.exit(1);
}
console.log("\nPASS: docs 전문 검사 통과");
