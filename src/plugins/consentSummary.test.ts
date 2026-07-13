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
    spec: "soksak-spec-plugin@1",
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
      nodes: [],
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

  it("위험 명령(danger)이 동의 요약에 이름·종류로 노출(U4)", () => {
    const m = mani("danger-demo", ["commands", "commands:destructive", "commands:inject"]);
    m.contributes.commands = [
      { name: "wipe", title: "지우기", danger: "destructive" },
      { name: "send", title: "보내기", danger: "inject" },
      { name: "list", title: "목록" }, // 위험 아님 — 제외
    ] as PluginManifest["contributes"]["commands"];
    const s = consentSummary(m, { "danger-demo": rt(m) });
    expect(s.dangerousCommands).toEqual([
      { name: "wipe", danger: "destructive" },
      { name: "send", danger: "inject" },
    ]);
  });
});

describe("consentSummary — 노출 DOM 노드(동의 화면)", () => {
  it("contributes.nodes 가 exposedNodes 로(id·설명·danger)", () => {
    const m = mani("p", ["ui"]);
    (m.contributes as { nodes: unknown[] }).nodes = [
      { id: "submit", description: { ko: "전송", en: "Submit" } },
      { id: "msg", description: "메시지 행" },
      { id: "wipe", danger: true },
    ];
    const ex = consentSummary(m, { p: rt(m) }).exposedNodes;
    expect(ex.map((n) => n.id)).toEqual(["submit", "msg", "wipe"]);
    expect(ex[2].danger).toBe(true);
    expect(ex[0].description).toEqual({ ko: "전송", en: "Submit" });
  });
  it("노출 노드 없으면 빈 배열", () => {
    const m = mani("p", ["ui"]);
    expect(consentSummary(m, { p: rt(m) }).exposedNodes).toEqual([]);
  });
});
