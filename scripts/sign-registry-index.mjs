#!/usr/bin/env node
// 프로덕션 서명 레지스트리 인덱스 생성기.
// - ed25519 키페어: secret/registry-signing-key.json (없으면 생성, gitignore). 공개키 → registry-public-key.json.
// - 발행 유닛(org의 immutable v0.0.1) 집계 → units[]{id,kind,manifest{url,sha256},reports[]} → RFC8785 canonical → ed25519 서명.
// 인수: --org soksak-ai --registry-id official --out <dir> --now <ms> --units-json <path>
import { createHash, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalRegistryPayload } from "../packages/plugin-spec/dist/registry.js";

function opt(name, def) { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : def; }
const ORG = opt("--org", "soksak-ai");
const REGISTRY_ID = opt("--registry-id", "official");
const SEQUENCE = Number(opt("--sequence", "1"));
const OUT = opt("--out", ".");
const NOW = Number(opt("--now", `${Date.now()}`));
// 서명 인덱스는 홈-설치 유닛(kit|plugin|sidecar)만 싣는다. 계약은 빌드-핀 소비라 제외.
const UNITS = JSON.parse(fs.readFileSync(opt("--units-json"), "utf8"))
  .filter((u) => ["kit", "plugin", "sidecar"].includes(u.kind)); // [{id,kind}]
const KEY_PATH = opt("--key", path.resolve(process.env.HOME, "soksak/core/secret/registry-signing-key.json"));

// 1) 키페어
let key;
if (fs.existsSync(KEY_PATH)) {
  key = JSON.parse(fs.readFileSync(KEY_PATH, "utf8"));
} else {
  const pair = generateKeyPairSync("ed25519");
  const publicKeyDer = pair.publicKey.export({ type: "spki", format: "der" });
  const raw = publicKeyDer.subarray(-32); // ed25519 raw public key
  const keyId = createHash("sha256").update(raw).digest("hex").slice(0, 32);
  key = {
    keyId,
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyBase64: raw.toString("base64"),
  };
  fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
  fs.writeFileSync(KEY_PATH, JSON.stringify(key, null, 2) + "\n");
  console.error(`서명키 생성 → ${KEY_PATH} (keyId=${key.keyId})`);
}

// 2) units — 각 유닛 release.json + conformance 를 fetch, sha256
async function fetchSha(url) {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf };
}
const base = (id, version) => `https://github.com/${ORG}/${id}/releases/download/v${version}`;
const units = [];
for (const u of UNITS) {
  const unitVersion = u.version ?? "0.0.1";
  const manifestUrl = `${base(u.id, unitVersion)}/release.json`;
  const m = await fetchSha(manifestUrl);
  const release = JSON.parse(m.bytes.toString());
  const version = release.version ?? (release.contract && release.contract.version) ?? "0.0.1";
  // conformance 리포트: plugin=conformance-release.json+conformance-plugin.json, contract=conformance.json
  const reportNames = u.kind === "contract"
    ? ["conformance.json"]
    : u.kind === "sidecar"
      ? ["conformance-release.json", "conformance-sidecar.json"]
      : ["conformance-release.json", "conformance-plugin.json"];
  const reports = [];
  for (const n of reportNames) {
    try { const rr = await fetchSha(`${base(u.id, unitVersion)}/${n}`); reports.push({ sha256: rr.sha256, url: `${base(u.id, unitVersion)}/${n}` }); }
    catch { /* 없는 리포트는 생략 */ }
  }
  reports.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)); // 결정적 서명 위해 정렬
  units.push({ id: u.id, kind: u.kind, version, manifest: { sha256: m.sha256, url: manifestUrl }, reports });
  console.error(`  ${u.kind}:${u.id}@${version} sha=${m.sha256.slice(0, 12)} reports=${reports.length}`);
}
units.sort((a, b) => (a.kind + a.id < b.kind + b.id ? -1 : 1));

// 3) payload + 서명
const wholeSecond = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const payload = {
  spec: "soksak-spec-registry@0.0.1",
  registryId: REGISTRY_ID,
  sequence: SEQUENCE,
  issuedAt: wholeSecond(NOW),
  expiresAt: wholeSecond(NOW + 365 * 24 * 3600 * 1000),
  units,
};
const canonical = canonicalRegistryPayload(payload);
const signature = sign(null, Buffer.from(canonical), fs.existsSync(KEY_PATH) ? { key: key.privateKeyPem } : key.privateKeyPem).toString("base64");
const signed = { ...payload, signature: { algorithm: "ed25519", keyId: key.keyId, value: signature } };

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "registry-signed.json"), JSON.stringify(signed, null, 2) + "\n");
fs.writeFileSync(path.join(OUT, "registry-public-key.json"),
  JSON.stringify({ keyId: key.keyId, algorithm: "ed25519", value: key.publicKeyBase64 }, null, 2) + "\n");
console.error(`\n서명 인덱스 → ${OUT}/registry-signed.json (${units.length} units, keyId=${key.keyId})`);
console.log(JSON.stringify({ units: units.length, keyId: key.keyId }));
