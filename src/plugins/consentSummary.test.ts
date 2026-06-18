// 동의 요약 — 종속 플러그인 권한 전이 표기 계약 고정(반쪽 동의 방지: 종속의 권한도 동의 화면에 뜬다).
import { describe, expect, it } from "vitest";
import { consentSummary } from "./consentSummary";
import type { PluginManifest } from "./spec";
import type { PluginRuntime } from "../state/plugins";

function mani(
  id: string,
  permissions: string[],
  dependencies: Record<string, string> = {},
  version = "0.1.0",
): PluginManifest {
  return {
    spec: "soksak-plugin-spec@1",
    id,
    name: id,
    version,
    entry: "main.js",
    permissions: permissions as PluginManifest["permissions"],
    dependencies,
    contributes: {
      views: [],
      commands: [],
      formatters: [],
      languages: [],
      iconSets: [],
      programs: [],
      events: [],
    },
  } as unknown as PluginManifest;
}

function rt(manifest: PluginManifest): PluginRuntime {
  return { manifest, dir: "", source: "installed", status: "disabled" } as PluginRuntime;
}

describe("consentSummary — 종속 권한 전이 표기", () => {
  it("studio 동의 요약에 종속 core 의 권한이 함께 뜬다", () => {
    const core = mani("acp-core", ["process", "fs:read"]);
    const studio = mani("acp-studio", ["ui", "commands"], { "acp-core": "^0.1.0" });
    const installed = { "acp-core": rt(core), "acp-studio": rt(studio) };

    const s = consentSummary(studio, installed);
    expect(s.dependencies.plugins).toHaveLength(1);
    const dep = s.dependencies.plugins[0];
    expect(dep.id).toBe("acp-core");
    expect(dep.range).toBe("^0.1.0");
    expect(dep.permissions).toEqual(["process", "fs:read"]); // 종속 권한 노출(핵심)
    expect(dep.version).toBe("0.1.0");
  });

  it("전이 종속(addon→lounge→core)의 권한까지 모은다", () => {
    const core = mani("core", ["process"]);
    const lounge = mani("lounge", ["ui"], { core: "^0.1.0" });
    const addon = mani("addon", ["commands"], { lounge: "^0.1.0" });
    const installed = { core: rt(core), lounge: rt(lounge), addon: rt(addon) };

    const ids = consentSummary(addon, installed).dependencies.plugins.map((p) => p.id);
    expect(new Set(ids)).toEqual(new Set(["lounge", "core"])); // 직접+전이 모두
    const coreDep = consentSummary(addon, installed).dependencies.plugins.find((p) => p.id === "core");
    expect(coreDep?.permissions).toEqual(["process"]);
    expect(coreDep?.transitive).toBe(true); // core 는 addon 의 전이 의존
  });

  it("미설치 종속은 권한 미상으로 표기(설치 후 동의)", () => {
    const studio = mani("acp-studio", ["ui"], { "acp-core": "^0.1.0" });
    const installed = { "acp-studio": rt(studio) }; // core 미설치
    const dep = consentSummary(studio, installed).dependencies.plugins[0];
    expect(dep.id).toBe("acp-core");
    expect(dep.permissions).toBeUndefined();
  });

  it("종속 없으면 plugins 비어 있음", () => {
    const solo = mani("solo", ["ui"]);
    expect(consentSummary(solo, { solo: rt(solo) }).dependencies.plugins).toEqual([]);
  });
});
