#!/usr/bin/env node
// Public, headless validation boundary. Every mode calls the same parser/verifier that
// consumers import from dist/spec.js; the CLI does not maintain a second wire grammar.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  C2_STATIC_ENFORCEMENT,
  certifyRegistryIndex,
  parseConformanceReport,
  parseManifest,
  parseRegistryPublicKey,
  parseReleaseManifest,
  transparencyViolations,
  verifyConformanceReport,
  verifyPluginRuntimeDependencyProjection,
} from "../dist/spec.js";

const USAGE = `사용:
  soksak-validate plugin <플러그인 폴더 | plugin.json>...
  soksak-validate release <release.json>...
  soksak-validate conformance <report.json>... --release <release.json> [--plugin-manifest <plugin.json>]
  soksak-validate registry <registry.json> --public-key <key.json> --registry-id <id> --key-id <id> [--at <ISO-8601>] [--high-water <sequence>:<sha256>]

호환: 모드 없는 경로는 plugin 모드로 해석합니다.
종료코드: 0 = 통과, 1 = 문서/무결성 위반, 2 = 사용법 오류.`;

const MODES = new Set(["plugin", "release", "conformance", "registry"]);

function usageExit(message) {
  if (message) console.error(message);
  console.error(USAGE);
  return 2;
}

function readDocument(path, label = path) {
  try {
    const bytes = readFileSync(path);
    return { bytes, raw: JSON.parse(bytes.toString("utf8")) };
  } catch (error) {
    console.error(`✗ ${label}: UTF-8 JSON 읽기 실패 — ${error.message}`);
    return null;
  }
}

function printErrors(path, errors) {
  console.error(`✗ ${path}`);
  for (const error of errors) console.error(`  - ${error}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function parseOptions(args, known) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!known.has(arg) || options.has(arg)) {
      return { ok: false, error: `알 수 없거나 중복된 옵션: ${arg}` };
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `${arg}: 값이 필요합니다` };
    }
    options.set(arg, value);
    index++;
  }
  return { ok: true, positional, options };
}

function resolvePluginPaths(paths) {
  return paths.map((path) => {
    try {
      if (statSync(path).isDirectory()) return join(path, "plugin.json");
    } catch {
      // The read boundary below reports one canonical failure.
    }
    return path;
  });
}

function validatePlugins(paths) {
  let failed = 0;
  for (const path of resolvePluginPaths(paths)) {
    const document = readDocument(path);
    if (!document) {
      failed++;
      continue;
    }
    const dirName = basename(dirname(resolve(path)));
    const { manifest, validation } = parseManifest(document.raw, dirName);
    if (!validation.ok) {
      printErrors(path, validation.errors);
      failed++;
      continue;
    }
    const c2 = transparencyViolations(manifest.contributes);
    const blocking = c2.filter((violation) => C2_STATIC_ENFORCEMENT[violation.rule] === "blocking");
    const warned = c2.filter((violation) => C2_STATIC_ENFORCEMENT[violation.rule] === "warn");
    if (blocking.length > 0) {
      console.error(`✗ ${path}`);
      console.error("  C2 투명성 위반(blocking — 앱이 활성화를 거부한다):");
      for (const violation of blocking) console.error(`  - ${violation.rule} — ${violation.detail}`);
      for (const violation of warned) console.error(`  ⚠ C2 ${violation.rule}: ${violation.detail}`);
      failed++;
      continue;
    }
    console.log(`✓ ${path}`);
    for (const warning of validation.warnings ?? []) console.log(`  ⚠ ${warning}`);
    for (const violation of warned) console.log(`  ⚠ C2 ${violation.rule}: ${violation.detail}`);
  }
  return failed > 0 ? 1 : 0;
}

function validateReleases(paths) {
  let failed = 0;
  for (const path of paths) {
    const document = readDocument(path);
    if (!document) {
      failed++;
      continue;
    }
    const parsed = parseReleaseManifest(document.raw);
    if (!parsed.ok) {
      printErrors(path, parsed.errors);
      failed++;
      continue;
    }
    console.log(`✓ ${path} (${parsed.value.kind}:${parsed.value.id}@${parsed.value.version})`);
  }
  return failed > 0 ? 1 : 0;
}

function validateConformance(args) {
  const parsedArgs = parseOptions(args, new Set(["--release", "--plugin-manifest"]));
  if (!parsedArgs.ok) return usageExit(parsedArgs.error);
  const releasePath = parsedArgs.options.get("--release");
  if (!releasePath || parsedArgs.positional.length === 0) {
    return usageExit("conformance: report 경로와 --release가 필요합니다");
  }
  const releaseDocument = readDocument(releasePath, `owner release ${releasePath}`);
  if (!releaseDocument) return 1;
  const release = parseReleaseManifest(releaseDocument.raw);
  if (!release.ok) {
    printErrors(releasePath, release.errors);
    return 1;
  }
  const manifestSha256 = sha256(releaseDocument.bytes);
  const pluginManifestPath = parsedArgs.options.get("--plugin-manifest");
  let ownerPlugin;
  if (pluginManifestPath !== undefined) {
    const document = readDocument(pluginManifestPath, `plugin manifest ${pluginManifestPath}`);
    if (!document) return 1;
    const parsed = parseManifest(document.raw, release.value.id);
    if (!parsed.validation.ok || !parsed.manifest) {
      printErrors(pluginManifestPath, parsed.validation.errors);
      return 1;
    }
    if (
      release.value.kind !== "plugin" ||
      parsed.manifest.id !== release.value.id ||
      parsed.manifest.version !== release.value.version
    ) {
      printErrors(pluginManifestPath, ["plugin manifest identity must exactly match the owner plugin release"]);
      return 1;
    }
    const projection = verifyPluginRuntimeDependencyProjection(
      parsed.manifest.dependencies,
      release.value,
    );
    if (!projection.ok) {
      printErrors(pluginManifestPath, projection.errors);
      return 1;
    }
    ownerPlugin = parsed.manifest;
  }
  let failed = 0;
  for (const path of parsedArgs.positional) {
    const document = readDocument(path);
    if (!document) {
      failed++;
      continue;
    }
    const report = parseConformanceReport(document.raw);
    if (!report.ok) {
      printErrors(path, report.errors);
      failed++;
      continue;
    }
    const verified = verifyConformanceReport(
      report.value,
      release.value,
      manifestSha256,
      ownerPlugin?.implements ?? [],
    );
    if (!verified.ok) {
      printErrors(path, verified.errors);
      failed++;
      continue;
    }
    if (report.value.contract === "soksak-spec-plugin@0.0.1" && !ownerPlugin) {
      printErrors(path, [
        "soksak-spec-plugin@0.0.1 evidence requires --plugin-manifest so runtime plugin dependencies can be matched to the release closure",
      ]);
      failed++;
      continue;
    }
    console.log(`✓ ${path} (${report.value.contract})`);
  }
  return failed > 0 ? 1 : 0;
}

function parseHighWater(value) {
  if (value === undefined) return undefined;
  const separator = value.indexOf(":");
  if (separator < 1) return null;
  const sequence = Number(value.slice(0, separator));
  const digest = value.slice(separator + 1);
  return { sequence, digest };
}

async function validateRegistry(args) {
  const parsedArgs = parseOptions(
    args,
    new Set(["--public-key", "--registry-id", "--key-id", "--at", "--high-water"]),
  );
  if (!parsedArgs.ok) return usageExit(parsedArgs.error);
  if (parsedArgs.positional.length !== 1) {
    return usageExit("registry: registry.json 경로 하나가 필요합니다");
  }
  const publicKeyPath = parsedArgs.options.get("--public-key");
  const expectedRegistryId = parsedArgs.options.get("--registry-id");
  const expectedKeyId = parsedArgs.options.get("--key-id");
  if (!publicKeyPath || !expectedRegistryId || !expectedKeyId) {
    return usageExit("registry: --public-key, --registry-id, --key-id가 모두 필요합니다");
  }
  const atRaw = parsedArgs.options.get("--at");
  const now = atRaw === undefined ? Date.now() : Date.parse(atRaw);
  if (!Number.isFinite(now)) return usageExit("registry: --at은 유효한 ISO-8601 시각이어야 합니다");
  const highWater = parseHighWater(parsedArgs.options.get("--high-water"));
  if (highWater === null) return usageExit("registry: --high-water는 <sequence>:<sha256> 형식이어야 합니다");

  const registryPath = parsedArgs.positional[0];
  const registryDocument = readDocument(registryPath);
  const publicKeyDocument = readDocument(publicKeyPath, `public key ${publicKeyPath}`);
  if (!registryDocument || !publicKeyDocument) return 1;
  const publicKey = parseRegistryPublicKey(publicKeyDocument.raw);
  if (!publicKey.ok) {
    printErrors(publicKeyPath, publicKey.errors);
    return 1;
  }
  const certified = await certifyRegistryIndex(registryDocument.raw, {
    expectedRegistryId,
    expectedKeyId,
    publicKey: publicKey.value,
    now,
    ...(highWater === undefined ? {} : { highWater }),
  });
  if (!certified.ok) {
    printErrors(registryPath, [`${certified.code}: ${certified.errors.join("; ")}`]);
    return 1;
  }
  console.log(
    `✓ ${registryPath} (registry=${certified.value.index.registryId} sequence=${certified.value.index.sequence} digest=${certified.value.digest} continuity=${certified.value.continuity})`,
  );
  return 0;
}

async function main(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (argv.length === 0) return usageExit();
  const explicitMode = MODES.has(argv[0]);
  const mode = explicitMode ? argv[0] : "plugin";
  const args = explicitMode ? argv.slice(1) : argv;
  if (args.length === 0) return usageExit(`${mode}: 입력 경로가 필요합니다`);
  if (mode === "plugin") return validatePlugins(args);
  if (mode === "release") return validateReleases(args);
  if (mode === "conformance") return validateConformance(args);
  return validateRegistry(args);
}

process.exitCode = await main(process.argv.slice(2));
