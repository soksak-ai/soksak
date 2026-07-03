# soksak-sidecar-chromium

Chromium engine sidecar for soksak — the `engine`-model shared native module
(in-process dylib) behind the `Browser ▸ Chromium` plugin. The core never links
this crate; it dlopens the built dylib at plugin request and speaks the opaque
`soksak-engine-chromium@1` message protocol over the generic hosting ABI
(`soksak-engine-abi`, see `docs/SIDECARS.md`).

## Provenance / attribution

The embedding carrier is **CEF (Chromium Embedded Framework)** via the
[`cef`](https://crates.io/crates/cef) Rust crate (BSD-licensed, as is Chromium).
Per the naming law (`docs/NAMING.md` §2) the carrier's name lives only inside
this crate — everything the project mints is named after the observable engine,
Chromium.

## Layout (staged dist)

```
~/.soksak/sidecars/soksak-sidecar-chromium/dist/
  soksak-sidecar-chromium.dylib            # this crate's cdylib (ABI surface)
  Chromium Embedded Framework.framework/   # runtime-dlopened engine
  soksak-sidecar-chromium Helper.app/      # subprocess helper (renderer/GPU/…)
```

`dist/` plays the role of the canonical CEF macOS `Frameworks/` directory, so
the helper's relative framework resolution works unmodified.

- Dev staging: `make sidecar-chromium` (framework comes from the cef build OUT_DIR).
- Dev override: `SOKSAK_SIDECAR_CHROMIUM_BIN=<path to dylib>`.
- Diagnostics: `SOKSAK_SIDECAR_CHROMIUM_NO_TICK=1` disables the render tick
  (event-pump-only measurement).

## Protocol (soksak-engine-chromium@1)

Requests: `create(x,y,w,h,url)→{id}`, `bounds`, `load`, `reload(ignoreCache)`,
`back`, `forward`, `hidden`, `focus`, `close`, `popup-mode(asWindow)`.
Events: `{event:"popup-url", url, id}` (new-link routing when popup-mode=tab).
Host notify consumed: `{type:"surface-occluded", occluded}`.
