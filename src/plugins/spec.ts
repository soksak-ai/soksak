// 코어 내부 경로 호환 shim — 실제 spec(parseManifest 등 단일진실)은 @soksak/plugin-spec 패키지.
// spec 을 패키지로 분리(pnpm workspace)하면서 코어 24곳의 import("./spec" 등)을 깨지 않는다.
// 단일진실: 로직은 패키지(packages/plugin-spec/src/spec.ts)에만, 여기는 re-export 한 줄(중복 0).
// 저자 게이트는 같은 패키지를 npx soksak-validate 로 — vsce 모델.
export * from "@soksak/plugin-spec";
