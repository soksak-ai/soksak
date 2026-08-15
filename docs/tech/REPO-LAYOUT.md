---
kind: canonical
status: active
canonical: self
---

# Repository layout


A folder name declares who owns what is inside it.

## L1. The workspace

```
wails3beta/
├── soksak-core/        the application
├── soksak-plugins/     plugins, one repository each
├── wails-services/     Wails services this project wrote
├── frameworks/         framework checkouts, pinned
├── externals/          third-party libraries
└── backup/             removed material, referenced by no build
```

Four rules produce this:

1. Ours and not-ours are separate. `frameworks/` and `externals/` hold code from elsewhere;
   everything else is written here.
2. A plugin adds a feature and can be switched off (A8). A Wails service extends the host and cannot.
   They are different kinds, so they are different folders.
3. A checkout is pinned. `frameworks/wails3` is at one commit, and moving it is legislation with its
   own commit, not a side effect (see NATIVE-LAYER.md).
4. `backup/` is invisible to every build and gate. Anything the build needs is not in it.

`go.mod` `replace` directives and `frontend/package.json` `file:` dependencies both address these
paths, so a move here is a two-line change in the application.

## L2. Inside the application

```
soksak-core/
├── main.go             the composition root: identity, home claim, registry, host
├── launch.go           claims the home before anything is drawn
├── core/               framework-independent Go: no window, no vendor
├── frameworks/wails/   this host: windows, capture, native surfaces, the service list
├── cmd/sok             the control-plane CLI
├── frontend/           the renderer
├── docs/               contracts (tech/) and procedures (manual/)
├── build/              packaging inputs
├── bin/                the two binaries this project produces: soksak, sok
```

`core/` never names a framework or a plugin, and `go test ./core/...` answers commands with no
window. `frameworks/wails/` may name both — it is the only package that can.

Root-level Go files are the composition root and its gates: `main.go`, `launch.go`,
`process_sink.go`, `pid_*.go`, plus `observation_gate_test.go` and `provenance_gate_test.go`, which
scan the whole repository and therefore have to sit at its root.

## L3. Two binaries, no more

`bin/soksak` is the application. `bin/sok` is the control-plane client. A third name in `bin/`
means a build that nobody will remember tomorrow; a gate refuses any Go binary at the repository
root.

## L4. Where a document goes

`docs/tech/` holds contracts. `docs/manual/` holds procedures. `docs/investigations/<topic>/` holds
hypotheses, and its conclusion moves into a contract when it settles.

Every one of them is English. Korean lives only in the `ko` values of the resource bundles (AGENTS 6-1).
`docs/README.md` is the register, and a document that is not in it does not exist.
