#!/usr/bin/env node
// Release 전용 Tauri override 생성기. 공개키를 source tree placeholder로 보관하지 않고
// release job의 명시적 입력으로 받아 target/ 아래 생성물에만 기록한다.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const basePath = resolve(arg("--base", "src-tauri/tauri.release.conf.json"));
const outPath = resolve(arg("--out", "src-tauri/target/release-config/tauri.conf.json"));
const publicKey = (process.env.TAURI_UPDATER_PUBLIC_KEY ?? "").trim();

if (!publicKey || /placeholder/i.test(publicKey)) {
  console.error("release config: TAURI_UPDATER_PUBLIC_KEY 실제 공개키가 필요합니다");
  process.exit(1);
}

const config = JSON.parse(readFileSync(basePath, "utf8"));
config.plugins = {
  ...(config.plugins ?? {}),
  updater: {
    endpoints: ["https://github.com/soksak-ai/soksak-app/releases/latest/download/latest.json"],
    pubkey: publicKey,
  },
};
config.bundle = { ...(config.bundle ?? {}), createUpdaterArtifacts: true };

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
console.log(`release config: ${outPath}`);

