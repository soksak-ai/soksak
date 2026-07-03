#!/usr/bin/env node
// crash-reports — soksak 앱 크래시 리포트(.ips) 요약. 매번 즉석 파서를 짜지 않기 위한 상비 진단.
//
//   node scripts/diag/crash-reports.mjs [N]   # 최근 N건(기본 5) — 시각/예외/원인/결정 프레임
//
// 출력 프레임 선정: faultingThread 상위에서 시스템 프리앰블을 걷어내고 앱/CEF 프레임을 우선.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = path.join(os.homedir(), "Library/Logs/DiagnosticReports");
const N = Number(process.argv[2] || 5);

const files = fs
  .readdirSync(DIR)
  .filter((f) => /^soksak.*\.ips$/.test(f))
  .map((f) => ({ f, m: fs.statSync(path.join(DIR, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m)
  .slice(0, N);

if (files.length === 0) {
  console.log("soksak 크래시 리포트 없음:", DIR);
  process.exit(0);
}

for (const { f } of files) {
  const raw = fs.readFileSync(path.join(DIR, f), "utf8");
  const nl = raw.indexOf("\n");
  let body;
  try {
    body = JSON.parse(raw.slice(nl + 1));
  } catch {
    console.log(`── ${f}: 본문 파싱 실패`);
    continue;
  }
  const exc = body.exception || {};
  const er = body.exceptionReason || {};
  const term = body.termination || {};
  const imgs = body.usedImages || [];
  const ft = body.faultingThread ?? 0;
  const frames = (body.threads?.[ft]?.frames || [])
    .map((fr) => {
      const img = imgs[fr.imageIndex]?.name || "?";
      return `${img}:${fr.symbol || "+" + fr.imageOffset}`;
    })
    .filter((s) => !/^(libsystem|libdispatch|dyld|CoreFoundation:__CF|HIToolbox|AppKit:_DPS)/.test(s));
  console.log(`── ${f}`);
  console.log(`   ${exc.type || "?"} | ${term.indicator || ""} | ${er.composed_message || er.name || ""}`);
  for (const s of frames.slice(0, 5)) console.log(`   ${s}`);
}
