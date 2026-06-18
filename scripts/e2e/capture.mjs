// 캡처 E2E — window.snapshot 이 "다양한 환경"(콘텐츠 네이티브 child webview = 브라우저 뷰)을
// 빠짐없이 캡처하는지 자가 검증한다. RED→GREEN 의 검증 도구(일회용 아님 — 멱등, 만든 것은 정리).
//
// 현상: 메인 webview 만 캡처하면 콘텐츠 영역(브라우저 child webview)이 hole 로 빠진다.
//   → 콘텐츠에 마커색(red) 페이지를 띄우고 캡처 중앙 픽셀을 검사한다. red 면 GREEN, 아니면 RED.
//
// 실행: SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node scripts/e2e/capture.mjs
// 종료코드: 0=GREEN, 1=RED(현상 재현 또는 실패).

import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import fs from "node:fs";

const SOCKET = process.env.SOKSAK_SOCKET || path.join(os.homedir(), ".soksak", "com.soksak.dev.sock");
const MARKER = "file://" + (process.env.MARKER || "/tmp/marker.html");

let sock, seq = 0;
const pending = new Map();
let rbuf = "";
function connect() {
  return new Promise((resolve, reject) => {
    sock = net.createConnection(SOCKET);
    sock.setNoDelay(true);
    sock.once("connect", resolve);
    sock.once("error", reject);
    sock.on("data", (d) => {
      rbuf += d.toString("utf8");
      let i;
      while ((i = rbuf.indexOf("\n")) >= 0) {
        const line = rbuf.slice(0, i);
        rbuf = rbuf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        const p = pending.get(msg.id);
        if (p) { pending.delete(msg.id); p(msg); }
      }
    });
  });
}
function rpc(method, params = {}, window) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    const req = { id, method, params };
    if (window) req.window = window;
    sock.write(JSON.stringify(req) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`TIMEOUT ${method}`)); } }, 15000);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 의존성 0 PNG 디코더(8-bit RGB/RGBA) — 비율 좌표의 픽셀 색 반환.
function pngPixel(file, fx, fy) {
  const b = fs.readFileSync(file);
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20);
  const bitDepth = b[24], colorType = b[25];
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!ch || bitDepth !== 8) throw new Error(`unsupported png (depth ${bitDepth} type ${colorType})`);
  const idat = [];
  let off = 8;
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    if (type === "IDAT") idat.push(b.subarray(off + 8, off + 8 + len));
    off += 12 + len;
    if (type === "IEND") break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    for (let x = 0; x < stride; x++) {
      const v = raw[p++];
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const ul = (x >= ch && y > 0) ? out[(y - 1) * stride + x - ch] : 0;
      let r;
      if (f === 0) r = v;
      else if (f === 1) r = v + a;
      else if (f === 2) r = v + up;
      else if (f === 3) r = v + ((a + up) >> 1);
      else if (f === 4) { const pa = Math.abs(up - ul), pb = Math.abs(a - ul), pc = Math.abs(a + up - 2 * ul); const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? up : ul); r = v + pr; }
      else r = v;
      out[y * stride + x] = r & 0xff;
    }
  }
  const px = Math.min(w - 1, Math.floor(fx * w)), py = Math.min(h - 1, Math.floor(fy * h));
  const i = py * stride + px * ch;
  return { r: out[i], g: out[i + 1], b: out[i + 2], w, h };
}

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✓ ${m}`); } else { fail++; console.log(`  ✗ ${m}`); } return c; };

async function main() {
  await connect();
  console.log("캡처 E2E\n마커:", MARKER);

  // 콘텐츠 영역에 마커색 브라우저 뷰(네이티브 child webview)
  const opened = await rpc("browser.open", { url: MARKER, where: "panel" });
  ok(opened.ok, `browser.open(마커) → view ${opened.viewId}`);
  await sleep(1500); // 페이지 로드 + 컴포지트

  const shot = "/tmp/soksak-capture-test.png";
  const snap = await rpc("window.snapshot", { path: shot });
  ok(snap.ok && fs.existsSync(shot), `window.snapshot → ${shot}`);

  // 콘텐츠 영역(화면 중앙)의 픽셀이 마커색(red)인가 = child webview 포함 여부
  const px = pngPixel(shot, 0.5, 0.55);
  const isRed = px.r > 170 && px.g < 90 && px.b < 90;
  console.log(`  중앙 픽셀 rgb(${px.r},${px.g},${px.b}) @ ${px.w}x${px.h}`);
  ok(isRed, "콘텐츠(브라우저 child webview)가 캡처에 포함됨 = 마커색");

  // 정리: 마커 브라우저 뷰 닫기
  if (opened.viewId) await rpc("view.close", { view: opened.viewId }).catch(() => {});

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  sock.end();
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error("E2E 실패:", e.message); process.exit(1); });
