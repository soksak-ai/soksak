# @soksak/plugin-spec

Single source of truth for the soksak plugin manifest spec, plus a headless `parseManifest`
validator. The soksak core imports the same `parseManifest`; plugin authors use the CLI to
gate their manifest before publish — no app required.

## Requirements

Node.js >= 22.18 — the validator loads the pure-TypeScript `spec.ts` via native type
stripping (no build step, no dependencies).

## Validate a manifest

```bash
npx soksak-validate plugin.json
# exit 0 = pass, 1 = rejected (reasons printed), 2 = usage error
```

Wire it into your plugin repo's pre-commit / CI:

```json
{ "scripts": { "validate": "soksak-validate plugin.json" } }
```

## Programmatic use

```ts
import { parseManifest } from "@soksak/plugin-spec";

const { validation } = parseManifest(raw, dirName);
if (!validation.ok) console.error(validation.errors);
```

## Two conformance surfaces

This package is the **headless schema gate** — it proves manifest *shape* without an app.
Runtime conformance (declared ≡ actual wiring across commands/views/fileViewers/iconSets and
DOM nodes) needs a running app via `sok plugin.conformance`. The schema gate does not prove
wiring; it proves shape.

## License

MIT
