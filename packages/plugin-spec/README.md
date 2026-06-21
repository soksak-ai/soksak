# @soksak/plugin-spec

The soksak plugin manifest spec and its `parseManifest` validator — the single source of
truth shared by the soksak runtime and by plugin authors. Validate a `plugin.json` before
you ship, with no app and no build step.

## Requirements

Node.js >= 22.18 — the validator runs the spec as pure TypeScript via native type stripping
(no build, no dependencies).

## CLI

```bash
npx soksak-validate plugin.json
```

Exit codes: `0` pass · `1` rejected (reasons printed) · `2` usage error. Wire it into your
plugin repo so a broken manifest fails before publish:

```json
{ "scripts": { "validate": "soksak-validate plugin.json" } }
```

## Programmatic

```ts
import { parseManifest } from "@soksak/plugin-spec";

const { manifest, validation } = parseManifest(raw, dirName);
if (!validation.ok) throw new Error(validation.errors.join("\n"));
```

`parseManifest(raw, dirName)` returns `{ manifest, validation }`, where `validation` is
`{ ok, errors, warnings }`. `dirName` is the plugin's directory name — the spec requires the
manifest `id` to equal it. Validation is all-or-nothing: `manifest` is `null` on rejection.

## License

MIT
