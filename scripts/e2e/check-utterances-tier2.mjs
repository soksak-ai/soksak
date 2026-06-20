#!/usr/bin/env node
// 발화 E2E Tier2 — 실모델 라우팅(docs/I18N.md §6, Stage 5). 사용자가 명시 요청한 "발화가 되는지".
// 합성 카탈로그(sok commands, AI 가 보는 그 표면)를 실제 claude 에 주고, 한 발화에 어떤 단일 명령을
// 고르는지 받아 expect 와 대조. positive=expect 발동, disambiguation=내장 vs 외부 구분(크롬으로 열어줘 →
// browser.open 발동 안 함), negative=NONE.
//
// 비결정적(실모델) → CI 하드 게이트 아님. pass-rate 로 본다. 토큰 소비.
// 사용: SOKSAK_ENV=dev node scripts/e2e/check-utterances-tier2.mjs [--only pin,browser]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SOK = join(here, "../../src-tauri/target/release/sok");
const ENV = process.env.SOKSAK_ENV || "dev";
const onlyArg = process.argv.indexOf("--only");
const only = onlyArg !== -1 ? process.argv[onlyArg + 1].split(",") : null;

function catalogText() {
  const out = execFileSync(SOK, ["commands"], {
    env: { ...process.env, SOKSAK_ENV: ENV },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const d = JSON.parse(out);
  const list = Array.isArray(d) ? d : d.commands || [];
  // 이름 + 합성 description 만(AI 발견 표면). params 는 생략(라우팅에는 description 이 결정).
  return list.map((c) => `${c.name} — ${c.description}`).join("\n");
}

// 실모델에게 라우터 역할 — 발화 1개 → 단일 명령 이름 또는 NONE.
// 산문 응답에 강건: 마지막 `FINAL: <name>` 줄만 파싱(모델이 추론을 적어도 무방).
function askModel(catalog, utterance) {
  const prompt = `You are a command router for the soksak terminal app. Below is the FULL list of soksak commands (name — description). Pick the SINGLE best-matching soksak command for the user's intent, or NONE if no soksak command fits (request unrelated, or it wants an EXTERNAL/named app — e.g. Chrome/Safari/an agent browser — rather than soksak's own embedded feature).

Think briefly if you must, but END your reply with exactly one line:
FINAL: <command-name>
(or "FINAL: NONE")

COMMANDS:
${catalog}

USER SAID: "${utterance}"`;
  const out = execFileSync("claude", ["-p"], {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 120000,
  });
  const m = out.match(/FINAL:\s*([A-Za-z0-9_.-]+)/g);
  if (m && m.length) {
    return m[m.length - 1].replace(/FINAL:\s*/, "").trim();
  }
  // FINAL 누락 시 폴백: 마지막 비어있지 않은 줄의 첫 토큰.
  const lines = out.trim().split("\n").filter((l) => l.trim());
  return (lines[lines.length - 1] || "NONE").trim().split(/\s+/)[0].replace(/[`."']/g, "");
}

function main() {
  const corpus = JSON.parse(readFileSync(join(here, "utterance-corpus.json"), "utf8"));
  const catalog = catalogText();

  const cases = [];
  for (const s of corpus.positive)
    cases.push({ ...s, kind: "positive", want: s.expect, expectAny: s.expectAny });
  for (const s of corpus.disambiguation || [])
    cases.push({ ...s, kind: "disambig", want: s.expect || "NONE", forbid: s.mustNotTrigger });
  for (const s of corpus.negative) cases.push({ ...s, kind: "negative", want: "NONE" });

  let pass = 0;
  const rows = [];
  for (const s of cases) {
    if (only && !only.some((o) => s.id.includes(o))) continue;
    let got;
    try {
      got = askModel(catalog, s.utterance);
    } catch (e) {
      rows.push(`  ? ${s.id}: 모델 호출 실패 ${e.message.slice(0, 60)}`);
      continue;
    }
    let ok;
    if (s.forbid) ok = got !== s.forbid; // 발동 금지 명령을 안 골랐으면 통과
    else if (s.want === "NONE") ok = got === "NONE";
    else if (s.expectAny) ok = s.expectAny.includes(got); // 모호 발화 — 복수 정답 허용
    else ok = got === s.want;
    if (ok) pass++;
    rows.push(`  ${ok ? "✓" : "✗"} [${s.kind}] ${s.id} (${s.lang}) "${s.utterance}"\n        want=${s.forbid ? "≠" + s.forbid : s.want}  got=${got}`);
  }
  const total = rows.filter((r) => r.includes("✓") || r.includes("✗")).length;
  console.log(rows.join("\n"));
  console.log(`\n발화 Tier2(실모델): ${pass}/${total} 통과 (비결정적 — pass-rate)`);
}

main();
