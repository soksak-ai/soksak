// 코어 내부 경로 호환 shim — 실제 spec(parseManifest 등 단일진실)은 @soksak/plugin-spec 패키지.
// 코어 24곳의 import("./spec" 등)을 깨지 않으면서 패키지를 *이름으로* 정상 경유한다(내부 경로 찌르지 않음).
// 패키지 exports 는 빌드물 dist(.js+.d.ts) — 코어 빌드/검증 전에 make spec-gate(= 패키지 build)가 dist 를
// 산출한다. 단일진실 소스는 packages/plugin-spec/src/spec.ts, 저자 게이트는 npx soksak-validate.
export * from "@soksak/plugin-spec";
