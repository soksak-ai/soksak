---
kind: canonical
status: active
canonical: REPO-LAYOUT.md
---

# Repository layout

English canonical: [`REPO-LAYOUT.md`](REPO-LAYOUT.md). Where the two differ, English wins.

A folder name declares who owns what is inside it.

## L1. The workspace

```
wails3beta/
├── soksak-core/        the application
├── soksak-plugins/     plugins, one repository each
├── wails-services/     Wails services this project wrote
├── frameworks/         framework checkouts, pinned
├── externals/          third-party libraries
└── backup/             removed material. Referenced by no build
```

Four rules produce this layout.

1. Separate ours from theirs. `frameworks/` and `externals/` are code from outside, and the rest is
   is what is written here.
2. A plugin adds a feature and can be switched off (A8). A Wails service extends the host and cannot be switched off.
   They are different kinds, so they are different folders.
3. A checkout is a pin. `frameworks/wails3` is at one commit, and moving it is not a side effect
   but legislation with a commit of its own (NATIVE-LAYER.md).
4. `backup/` is invisible to every build and gate. Anything the build needs is not in it.

The `replace` in `go.mod` and the `file:` dependency in `frontend/package.json` point at these paths. From here
one move changes two lines in the application.

## L2. Inside the application

```
soksak-core/
├── main.go             the composition root — identity, home claim, registry, host
├── launch.go           claims the home before anything is drawn
├── core/               framework-independent Go. No window, no vendor
├── frameworks/wails/   this host — windows, capture, native surfaces, the service list
├── cmd/sok             the control-plane CLI
├── frontend/           the renderer
├── docs/               contracts (tech/) and procedures (manual/)
├── build/              packaging inputs
├── bin/                the two binaries this project produces — soksak, sok
└── local/              gitignored. Not part of the record. Referenced by no build
```

`core/` names neither the framework nor a plugin, and `go test ./core/...` runs the commands with no window
answers commands with no window. `frameworks/wails/` may name both — it is the only package that can.

Root-level Go files are the composition root and its gates: `main.go`, `launch.go`, `process_sink.go`, `pid_*.go`,
and, because they scan the whole repository and have to sit at its root, `observation_gate_test.go` and
`provenance_gate_test.go`.

## L3. There are only two binaries

`bin/soksak` is the application and `bin/sok` is the control-plane client. A third name in `bin/`
appears, that is one more build nobody will remember tomorrow. A Go binary at the repository root is what a gate
refuses it.

## L4. Where a document goes

`docs/tech/` is contract, `docs/manual/` is procedure, `docs/investigations/<topic>/` is hypothesis. When an investigation
settles, its conclusion moves into a contract document.

Each has an English canonical `X.md` and a Korean `X_KO.md`, changed together in the same commit. `docs/README.md`
is the register, and a document that is not in it does not exist.
