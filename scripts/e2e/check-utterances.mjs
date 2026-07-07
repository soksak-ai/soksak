#!/usr/bin/env node
// 발화 E2E Tier1 — 결정적 회귀 게이트(docs/I18N.md §6, Stage 5).
// AI 가 명령을 고르는 표면(`sok commands` 합성 카탈로그)을 그대로 읽어, 각 positive 시나리오의
// expect 명령 description 이 그 발화 언어 트리거어(tokens)를 담는지 단언한다. 누군가 description 을
// 영어 단독/stub 으로 되돌리면 ko 토큰이 사라져 RED — 발견성 퇴행을 코드로 막는다.
//
// 이건 lexical 게이트(싸고 결정적). 실제 모델 라우팅(특히 ja·negative)은 Tier2(실모델) 몫.
//
// 사용: E2E_IDENTITY=dev node scripts/e2e/check-utterances.mjs [--sok <path>]

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const sokArg = process.argv.indexOf("--sok");
const SOK =
  sokArg !== -1
    ? process.argv[sokArg + 1]
    : join(here, "../../src-tauri/target/release/sok");
const ENV = process.env.E2E_IDENTITY || "dev";

function sokCommands() {
  const out = execFileSync(SOK, ["commands"], {
    env: process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const d = JSON.parse(out);
  const list = Array.isArray(d) ? d : d.commands || [];
  const byName = new Map();
  for (const c of list) byName.set(c.name, c);
  return byName;
}

function main() {
  const corpus = JSON.parse(
    readFileSync(join(here, "utterance-corpus.json"), "utf8"),
  );
  let byName;
  try {
    byName = sokCommands();
  } catch (e) {
    console.error(`✗ sok commands 실패 (앱 미실행?): ${e.message}`);
    process.exit(2);
  }

  let pass = 0;
  const fails = [];
  for (const s of corpus.positive) {
    const cmd = byName.get(s.expect);
    if (!cmd) {
      fails.push(`[${s.id}] expect 명령 부재: ${s.expect}`);
      continue;
    }
    const desc = String(cmd.description || "").toLowerCase();
    const hit = s.tokens.find((t) => desc.includes(t.toLowerCase()));
    if (hit) {
      pass++;
      console.log(`  ✓ ${s.id} (${s.lang}) "${s.utterance}" → ${s.expect}  [matched: ${hit}]`);
    } else {
      fails.push(
        `[${s.id}] ${s.expect} description 에 트리거어 없음 (필요: ${s.tokens.join("|")})\n      desc: ${cmd.description}`,
      );
    }
  }

  console.log(
    `\n발화 Tier1: ${pass}/${corpus.positive.length} positive 통과 · negative ${corpus.negative.length}/tier2 ${corpus.tier2_only.length} 는 실모델(Tier2) 몫`,
  );
  if (fails.length) {
    console.error("\n✗ 실패:");
    for (const f of fails) console.error("  " + f);
    process.exit(1);
  }
  console.log("✓ 발화 Tier1 게이트 통과 — 합성 description 이 발화 트리거어를 담는다");
}

main();
