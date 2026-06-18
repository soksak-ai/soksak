// 전이 동의 체인 — studio 활성화 시 종속 core 도 동의 대상(종속 먼저 순서). 반쪽 동의 방지 계약 고정.
import { describe, expect, it } from "vitest";
import {
  consentValid,
  pendingConsentChain,
  type ConsentRecord,
  type PluginRuntime,
} from "./plugins";
import type { PluginManifest } from "../plugins/spec";

function rt(
  id: string,
  permissions: string[],
  dependencies: Record<string, string> = {},
  opts: { source?: "installed" | "dev"; version?: string } = {},
): PluginRuntime {
  const manifest = {
    spec: "soksak-plugin-spec@1",
    id,
    name: id,
    version: opts.version ?? "0.1.0",
    entry: "main.js",
    permissions,
    dependencies,
    contributes: {
      views: [], commands: [], formatters: [], languages: [], iconSets: [], programs: [], events: [],
    },
  } as unknown as PluginManifest;
  return { manifest, dir: "", source: opts.source ?? "installed", status: "disabled" } as PluginRuntime;
}

const consent = (version: string, permissions: string[]): ConsentRecord => ({
  version,
  permissions: permissions as ConsentRecord["permissions"],
});

describe("pendingConsentChain — 미동의 체인(종속 먼저)", () => {
  const plugins = {
    "acp-core": rt("acp-core", ["process", "fs:read"]),
    "acp-studio": rt("acp-studio", ["ui", "commands"], { "acp-core": "^0.1.0" }),
  };

  it("둘 다 미동의: [core, studio] (종속 먼저)", () => {
    expect(pendingConsentChain("acp-studio", plugins, {})).toEqual(["acp-core", "acp-studio"]);
  });

  it("core 만 동의됨: [studio] 남음", () => {
    const consents = { "acp-core": consent("0.1.0", ["process", "fs:read"]) };
    expect(pendingConsentChain("acp-studio", plugins, consents)).toEqual(["acp-studio"]);
  });

  it("둘 다 동의: 빈 배열(바로 활성화 가능)", () => {
    const consents = {
      "acp-core": consent("0.1.0", ["process", "fs:read"]),
      "acp-studio": consent("0.1.0", ["ui", "commands"]),
    };
    expect(pendingConsentChain("acp-studio", plugins, consents)).toEqual([]);
  });

  it("종속 약관 변경(core 권한 추가) → core 가 다시 미동의로 체인에 든다", () => {
    const changed = {
      "acp-core": rt("acp-core", ["process", "fs:read", "network"]), // 권한 추가됨
      "acp-studio": rt("acp-studio", ["ui", "commands"], { "acp-core": "^0.1.0" }),
    };
    const consents = {
      "acp-core": consent("0.1.0", ["process", "fs:read"]), // 옛 동의(network 없음)
      "acp-studio": consent("0.1.0", ["ui", "commands"]),
    };
    // studio 자신은 동의 유효하지만, 종속 core 가 재동의 필요 → 체인에 core 포함.
    expect(pendingConsentChain("acp-studio", changed, consents)).toEqual(["acp-core"]);
  });

  it("dev 소스 종속은 동의 면제(체인 제외)", () => {
    const devCore = {
      "acp-core": rt("acp-core", ["process"], {}, { source: "dev" }),
      "acp-studio": rt("acp-studio", ["ui"], { "acp-core": "^0.1.0" }),
    };
    expect(pendingConsentChain("acp-studio", devCore, {})).toEqual(["acp-studio"]);
  });

  it("consentValid: 버전·권한 모두 일치해야 유효", () => {
    const m = rt("x", ["ui", "commands"]).manifest;
    expect(consentValid(consent("0.1.0", ["ui", "commands"]), m)).toBe(true);
    expect(consentValid(consent("0.1.0", ["commands", "ui"]), m)).toBe(true); // 순서 무관
    expect(consentValid(consent("0.2.0", ["ui", "commands"]), m)).toBe(false); // 버전 불일치
    expect(consentValid(consent("0.1.0", ["ui"]), m)).toBe(false); // 권한 불일치
    expect(consentValid(undefined, m)).toBe(false);
  });
});
