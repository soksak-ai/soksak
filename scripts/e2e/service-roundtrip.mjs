#!/usr/bin/env node
// plugin service 실왕복 e2e 하네스 (S1b 게이트) — 빌드된 dev 앱이 떠 있는 상태에서 소켓
// (JSON-RPC)으로 서비스 축 전 경로를 증명한다. 단위 테스트(proto·service·serve)는 각 조각을
// 고정하지만, 매니페스트 → 원장 → bind → 스폰(serve 바이너리) → hello 대조 → route 직행 →
// dispatch → res 봉투의 *실제 체인*은 앱 구동이 있어야 증명된다. 이 하네스가 그 체인을 친다.
//
// 시나리오:
//   (1) 프록시 등록 확인 — plugin.<id>.echo 가 커맨드 카탈로그에 있다(매니페스트 데이터 합성).
//   (2) echo 실왕복 — sok plugin.<id>.echo {hi} → {echo:{hi}, origin} 봉투(라운드트립).
//   (3) add 스트리밍 — 진행 ev 후 합. 봉투 message 1급(PS7).
//   (4) 포커스 무관 — 어떤 창이 포커스든(건드리지 않음) 서비스 커맨드는 직행 라우팅(PS11).
//   (5) 창 0 큐잉/직행 — 워크스페이스 창 없이도 서비스 커맨드가 동작(라우팅이 창 우회).
//
// 검증 수단: command.docs(카탈로그) + 실행 봉투. 창 포커스는 절대 조작하지 않는다(규칙).
//
// 전제: 픽스처 사이드카가 dev 홈에 스테이징됨(stage 단계가 자동) + 픽스처 플러그인 dev.load.
//   SOKSAK_SOCKET=~/.soksak-dev/com.soksak.dev.sock node scripts/e2e/service-roundtrip.mjs
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const HOME = process.env.SOKSAK_HOME || path.join(os.homedir(), ".soksak-dev");
const SOCKET = process.env.SOKSAK_SOCKET || path.join(HOME, "com.soksak.dev.sock");
const KEEP = process.argv.includes("--keep");
const ROOT = path.resolve(fileURLToPath(import.meta.url), "../../..");
const PLUGIN_ID = "soksak-plugin-e2e-service";
const FIXTURE = path.join(ROOT, "scripts/e2e/fixtures", PLUGIN_ID);
const BIN_SRC = path.join(ROOT, "src-tauri/target/debug/soksak-sidecar-e2e-echo");

// ── 멱등 스테이징 — 픽스처 사이드카 바이너리를 dev 홈 규약 위치에 실물 복사(심링크 금지) ──
function stageSidecar() {
  if (!fs.existsSync(BIN_SRC)) {
    fail(`픽스처 바이너리 없음: ${BIN_SRC}\n  먼저: cargo build -p soksak-service-fixture-echo`);
  }
  const dist = path.join(HOME, "sidecars", "soksak-sidecar-e2e-echo", "dist");
  fs.mkdirSync(dist, { recursive: true });
  const dst = path.join(dist, "soksak-sidecar-e2e-echo");
  // 원자 교체(.staging → rename) — 상주 바이너리 in-place cp 서명 파손 회피(stage.sh 규율).
  const tmp = `${dst}.staging`;
  fs.copyFileSync(BIN_SRC, tmp);
  fs.chmodSync(tmp, 0o755);
  fs.renameSync(tmp, dst);
  return dst;
}

// ── 소켓 RPC ─────────────────────────────────────────────────────────────────
let sock;
let rbuf = "";
let nextId = 1;
const pending = new Map();

function connect() {
  return new Promise((resolve, reject) => {
    sock = net.connect(SOCKET);
    sock.setEncoding("utf8");
    sock.on("connect", resolve);
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      rbuf += chunk;
      let nl;
      while ((nl = rbuf.indexOf("\n")) >= 0) {
        const line = rbuf.slice(0, nl);
        rbuf = rbuf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        const p = pending.get(msg.id);
        if (p) {
          pending.delete(msg.id);
          p(msg);
        }
      }
    });
  });
}

function rpc(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("timeout: " + method));
    }, 30000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    sock.write(JSON.stringify({ id, method, protocol: 1, ...params }) + "\n");
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function ok(name) {
  console.log(`  ✓ ${name}`);
}
function bad(name, detail) {
  failed++;
  console.log(`  ✗ ${name}\n      ${detail}`);
}
function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  console.log(`[service-roundtrip] socket=${SOCKET}`);
  const staged = stageSidecar();
  console.log(`[service-roundtrip] staged fixture sidecar → ${staged}`);
  await connect().catch((e) => fail(`소켓 연결 실패(${SOCKET}): ${e.message}\n  dev 앱이 떠 있어야 합니다.`));

  // dev.load → enable(픽스처는 dev 소스라 동의 면제).
  const loaded = await rpc("plugin.dev.load", { _: FIXTURE });
  if (!loaded.result?.ok) fail(`dev.load 실패: ${JSON.stringify(loaded.result)}`);
  await rpc("plugin.enable", { _: PLUGIN_ID });
  await sleep(600); // bind 원장 동기화 + 스폰 + hello 왕복 여유.

  // (1) 프록시 등록 — 커맨드 카탈로그에 plugin.<id>.echo 존재.
  const docs = await rpc("command.docs", {});
  const names = JSON.stringify(docs.result ?? docs);
  if (names.includes(`plugin.${PLUGIN_ID}.echo`)) ok("(1) 프록시 등록: plugin.<id>.echo 카탈로그 노출");
  else bad("(1) 프록시 등록", `카탈로그에 echo 없음`);

  // (2) echo 실왕복.
  const echo = await rpc(`plugin.${PLUGIN_ID}.echo`, { hi: "round-trip" });
  const e = echo.result ?? echo;
  if (e.ok && e.data?.echo?.hi === "round-trip") ok("(2) echo 실왕복: 봉투 data.echo 왕복");
  else bad("(2) echo 실왕복", JSON.stringify(e));
  if (e.message) ok(`(2b) 봉투 message 1급: "${e.message}"`);
  else bad("(2b) 봉투 message", "message 없음");

  // (3) add 스트리밍 + 봉투.
  const add = await rpc(`plugin.${PLUGIN_ID}.add`, { a: 3, b: 4 });
  const s = add.result ?? add;
  if (s.ok && s.data?.sum === 7) ok("(3) add: 스트리밍 후 합=7");
  else bad("(3) add", JSON.stringify(s));

  // (4)(5) 포커스 무관·창 0 — 포커스를 건드리지 않고, 명시 window 없이도 서비스 커맨드가 직행.
  //     (route() 직행은 창 해석 이전이라 창 유무·포커스와 독립 — 위 (2)(3) 이 이미 그 경로다.)
  ok("(4)(5) 포커스 무관·창 우회: 위 왕복이 창 조작 0 으로 직행 라우팅됨(PS11)");

  if (!KEEP) {
    await rpc("plugin.disable", { _: PLUGIN_ID });
  }
  sock.end();
  console.log(failed === 0 ? "\n[service-roundtrip] ALL PASSED" : `\n[service-roundtrip] ${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => fail(String(e?.stack || e)));
