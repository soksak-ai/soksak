// plugin service 프록시 — bind:"service" 커맨드를 매니페스트 데이터만으로 레지스트리에 합성
// 등록한다(PS3·PS11, 규범 docs/PLUGIN-SERVICE.md). 핸들러는 손으로 쓰지 않는다 — 전부
// service_dispatch(Rust ServiceManager)로 포워딩하는 합성이다. 실행 진실은 ServiceManager
// 하나: 소켓/스케줄은 route() 직행, 창 발원만 이 프록시를 지나 같은 곳에 닿는다.
// 프록시 수명 = 플러그인 활성 수명(창 로더 1회) — 서비스 재시작과 무관(재등록 금지).
import type { CommandSpec, ParamSpec } from "../commands/registry";
import {
  pluginCommandName,
  resolveText,
  serviceOps,
  type ContributedSchedule,
  type PluginManifest,
} from "./spec";

export interface ServiceProxyDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  registerCommand: (name: string, spec: CommandSpec) => void;
  unregisterCommand: (name: string) => boolean;
  locale: () => string;
}

// 합성 스펙 — 매니페스트 커맨드 선언(ServiceCommandFields)을 레지스트리 CommandSpec 으로
// 사상한다. envelope:"service" 는 이 합성만 설정한다(PS7 — 플러그인 JS 에 열지 않는 seam).
export function synthesizeServiceSpec(
  manifest: PluginManifest,
  name: string,
  deps: ServiceProxyDeps,
): CommandSpec | null {
  const declared = manifest.contributes.commands.find((c) => c.name === name);
  if (!declared || declared.bind !== "service") return null;
  const full = pluginCommandName(manifest.id, name);
  return {
    description: declared.description ?? "",
    ...(declared.triggers ? { triggers: declared.triggers } : {}),
    params: (declared.params ?? {}) as Record<string, ParamSpec>,
    title: declared.title,
    returns: declared.returns ?? "object",
    ...(declared.danger ? { danger: declared.danger } : {}),
    envelope: "service",
    // 와이어 message 부재의 폴백 = 사람 라벨(MESSAGE-PROTOCOL §3 열화 규칙).
    message: () => resolveText(declared.title, deps.locale()),
    handler: async (params, ctx) =>
      (await deps.invoke("service_dispatch", {
        method: full,
        params,
        parent: ctx?.parent,
        origin: ctx?.origin,
      })) as Record<string, unknown>,
  } as CommandSpec;
}

// bind:"service" 커맨드 전부를 등록하고 일괄 해제 함수를 돌려준다(tracker.wrap 규약).
// markRegistered: declared≡actual 인벤토리(conformance)에 "합성 프록시가 actual" 임을
// 알린다 — 프록시가 곧 등록이므로 declared-but-not-registered 로 오보되지 않는다.
export function registerServiceProxies(
  manifest: PluginManifest,
  deps: ServiceProxyDeps,
  markRegistered?: (bareName: string) => void,
): () => void {
  const names: string[] = [];
  for (const c of manifest.contributes.commands) {
    if (c.bind !== "service") continue;
    const spec = synthesizeServiceSpec(manifest, c.name, deps);
    if (!spec) continue;
    const full = pluginCommandName(manifest.id, c.name);
    deps.registerCommand(full, spec);
    markRegistered?.(c.name);
    names.push(full);
  }
  return () => {
    for (const full of names.splice(0).reverse()) deps.unregisterCommand(full);
  };
}

// ── bus→서비스 브리지(PS15) ──────────────────────────────────────────────────────
// 서비스가 hello subscribe[] 로 선언한 bus 토픽을 이 창의 bus 에서 수집해 코어로 올린다
// (service_bus_push). 코어가 seq dedup 후 구독 서비스로 1회 push. 여러 창이 같은 변경에
// 반응해 같은 토픽을 발행해도, 발행 payload 의 dedupKey(플러그인이 실은 논리적 리비전)로
// 창 간 중복이 제거된다 — 없으면 매 발행이 올라가고 서비스가 흡수(구독은 트리거).
export interface BusBridgeDeps {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  busOn: (topic: string, fn: (payload: unknown) => void) => () => void;
}

export function registerBusBridge(
  manifest: PluginManifest,
  deps: BusBridgeDeps,
): () => void {
  const svc = manifest.service;
  const offs: Array<() => void> = [];
  for (const sub of svc?.subscribe ?? []) {
    // 선언 형식은 "bus:<topic>"(service.ts SUBSCRIBE_RE) — bus 축의 실제 토픽은 접두 제거.
    const busTopic = sub.startsWith("bus:") ? sub.slice("bus:".length) : sub;
    offs.push(
      deps.busOn(busTopic, (payload) => {
        const dedupKey =
          payload && typeof payload === "object" && typeof (payload as { dedupKey?: unknown }).dedupKey === "string"
            ? (payload as { dedupKey: string }).dedupKey
            : undefined;
        void deps.invoke("service_bus_push", {
          topic: sub,
          payload: payload ?? {},
          ...(dedupKey !== undefined ? { dedupKey } : {}),
        });
      }),
    );
  }
  return () => {
    for (const off of offs.splice(0).reverse()) off();
  };
}

// ── bind 원장 파생(PS9) ─────────────────────────────────────────────────────────
// 원장은 파생물이다: 원본은 매니페스트(단일 심판 parseManifest 의 판정 결과)와 활성/동의
// 상태. 여기서 이미-판정된 부분집합만 뽑아 코어(service_ledger_sync)에 내린다.

interface LedgerSchedule {
  name: string;
  command: string;
  params?: Record<string, unknown>;
  trigger: ContributedSchedule["trigger"];
  timeoutMs?: number;
  zombieBackstopMs?: number;
}

export interface LedgerServiceBinding {
  plugin: string;
  sidecar: string;
  interface: string;
  ops: string[];
  subscribe: string[];
  schedules: LedgerSchedule[];
  secrets: string[];
}

export interface BindLedger {
  version: 1;
  services: LedgerServiceBinding[];
}

export function buildServiceBinding(manifest: PluginManifest): LedgerServiceBinding | null {
  const svc = manifest.service;
  if (!svc) return null;
  return {
    plugin: manifest.id,
    sidecar: svc.sidecar,
    interface: svc.interface,
    ops: serviceOps(manifest),
    subscribe: svc.subscribe,
    schedules: (manifest.contributes.schedules ?? []).map((s) => ({
      name: s.name,
      command: s.command,
      ...(s.params ? { params: s.params } : {}),
      trigger: s.trigger,
      ...(s.timeoutMs !== undefined ? { timeoutMs: s.timeoutMs } : {}),
      ...(s.zombieBackstopMs !== undefined ? { zombieBackstopMs: s.zombieBackstopMs } : {}),
    })),
    secrets: [],
  };
}

export function buildBindLedger(manifests: PluginManifest[]): BindLedger {
  const services = manifests
    .map(buildServiceBinding)
    .filter((b): b is LedgerServiceBinding => b !== null)
    .sort((a, b) => a.plugin.localeCompare(b.plugin)); // 결정적 직렬화 — 내용 비교 멱등의 전제.
  return { version: 1, services };
}

// 활성(enabled) 매니페스트 집합에서 원장을 파생해 코어에 동기화한다. 어느 창이 불러도
// 결과가 같다(멱등) — 코어가 내용 동일이면 no-op 한다.
export async function syncServiceLedger(
  manifests: PluginManifest[],
  invoke: ServiceProxyDeps["invoke"],
): Promise<void> {
  await invoke("service_ledger_sync", { ledger: buildBindLedger(manifests) });
}
