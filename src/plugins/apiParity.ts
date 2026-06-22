// drift 가드 — @soksak-ai/plugin-api 발행 타입이 코어 SoksakPluginApi/PluginContext 와 양방향
// 호환(구조 동일)임을 코어 tsc 가 컴파일로 강제한다. 코어 표면(api.ts)을 바꾸면
// packages/plugin-api/src/index.ts 도 동기해야 이 파일이 통과한다(아니면 typecheck RED).
// 단일진실은 코어이고 패키지는 그 미러다.
import type { SoksakPluginApi, PluginContext } from "./api";
import type { PluginViewContext } from "./viewRegistry";
import type * as Pkg from "@soksak-ai/plugin-api";

declare const coreApi: SoksakPluginApi;
declare const pkgApi: Pkg.SoksakPluginApi;
declare const coreCtx: PluginContext;
declare const pkgCtx: Pkg.PluginContext;
declare const coreViewCtx: PluginViewContext;
declare const pkgViewCtx: Pkg.PluginViewContext;

// 양방향 할당 = 어느 한쪽에 필드가 더 있거나 타입이 다르면 컴파일 실패.
const _apiFwd: Pkg.SoksakPluginApi = coreApi;
const _apiRev: SoksakPluginApi = pkgApi;
const _ctxFwd: Pkg.PluginContext = coreCtx;
const _ctxRev: PluginContext = pkgCtx;
const _viewCtxFwd: Pkg.PluginViewContext = coreViewCtx;
const _viewCtxRev: PluginViewContext = pkgViewCtx;
void _apiFwd;
void _apiRev;
void _ctxFwd;
void _ctxRev;
void _viewCtxFwd;
void _viewCtxRev;
