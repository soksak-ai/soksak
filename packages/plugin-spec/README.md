# @soksak-ai/plugin-spec

The public soksak platform boundary for independently released plugins, sidecars, kits,
conformance reports, and signed registries. It is a validation library and CLI, not a
runtime implementation and not a central home for unit-specific contracts.

## Distribution

This package is `private: true` and is not published to npm. CI builds one deterministic,
npm-compatible tarball and publishes it as an immutable GitHub Release asset:

```text
tag:   plugin-spec-v<version>
asset: soksak-ai-plugin-spec-<version>.tgz
url:   https://github.com/soksak-ai/soksak-spec/releases/download/<tag>/<asset>
```

The release also contains a manifest with the exact SHA-256. Consumers download the exact
GitHub Release URL, verify SHA-256, then install the local tarball with their JavaScript
package client. Using npm/pnpm to unpack that file does not contact or publish to the npm
registry. Branch URLs, `latest`, and unverified archives are not valid pins.

Node.js 18 or newer is required. The package has no runtime dependencies.

## CLI

The installed tarball exposes `soksak-validate`:

```bash
soksak-validate plugin ./plugin.json
soksak-validate release ./weather.release.json
soksak-validate conformance ./plugin.conformance.json \
  --release ./weather.release.json \
  --plugin-manifest ./plugin.json
soksak-validate registry ./registry.json \
  --public-key ./registry-key.json \
  --registry-id community \
  --key-id community-2026
```

Registry mode performs Ed25519 signature, identity, validity-window, and optional high-water
continuity checks. It never reports success from shape validation alone. Exit codes are
`0` for pass, `1` for a rejected document or integrity check, and `2` for invalid CLI use.
For compatibility, a path without an explicit mode is treated as `plugin` mode.

## Programmatic API

```ts
import {
  certifyRegistryIndex,
  parseManifest,
  parseReleaseManifest,
  resolveRegistryDependency,
  verifyRegistryUnitRelease,
} from "@soksak-ai/plugin-spec";
```

All external input starts as `unknown` and must cross the relevant parser. Only
`certifyRegistryIndex` returns a `CertifiedRegistryIndex` usable by dependency resolution
and owner-release verification.

`parseManifest(raw, dirName)` remains the plugin-specific parser. Its manifest id must equal
`dirName`. `plugin.json` owns runtime declarations; source, install dependencies, artifacts,
and entrypoints are owned by `soksak-spec-release@0.0.1`.

## Plugin UI surfaces

Plugin code runs in opaque-origin sandbox documents. The controller document is non-visual;
visible UI exists only through manifest-declared surfaces:

- `contributes.overlays[]` declares `{id,title,scope,capturesInput}`. `scope` is `screen` or
  `pane` and requires the matching `ui:overlay:*` permission. The runtime module supplies an
  exactly matching static overlay provider. Every overlay starts hidden; only the host changes
  visibility or interactivity, and `capturesInput:false` makes interactive state ineligible.
- `contributes.headerActions[]` declares `{id,title,icon,command}` and requires `ui:titlebar`
  plus `commands`.
- `contributes.statusItems[]` declares `{id,title,command}` and requires `ui:statusbar` plus
  `commands`.

Header and status clicks execute the exactly named command from the same
`contributes.commands`; they do not carry callbacks. They are host-declarative, so an
`entry:null` service plugin may use them when the command is service-bound. Overlays require
plugin code and are therefore invalid with `entry:null`. IDs are flat lowercase kebab strings,
unknown keys are rejected, and runtime display-state updates cannot change placement, command
binding, or input eligibility.

## Language-neutral contract

JSON Schemas ship in `schema/`. Cross-language canonical/signature fixtures and valid
plugin/sidecar/kit closures ship in `test/fixtures/platform-wire/`. The normative ownership,
dependency, evidence, and certification rules are in
[`docs/PLATFORM-WIRE.md`](docs/PLATFORM-WIRE.md).

## License

MIT
