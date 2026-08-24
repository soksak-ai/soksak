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
├── soksak-kits/        shared plugin code, one repository each
├── soksak-sidecars/    plugin-owned processes, one repository each
├── soksak-contracts/   shared public contracts and acceptance suites
├── wails-services/     Wails services this project wrote
├── forks/              maintained upstream forks
├── libraries/          independently authored reusable libraries
├── externals/          unmodified third-party source
├── tests/              product-specific system and acceptance repositories
└── backup/             removed material, referenced by no build
```

These rules produce this:

1. Ownership and modification policy are visible in the folder name. `forks/` contains upstream
   source we intentionally maintain; `libraries/` contains reusable libraries we authored;
   `externals/` contains unmodified third-party source; `tests/` contains Soksak-specific system and
   acceptance repositories. Product dependencies still come from exact published releases.
2. A plugin adds a feature and can be switched off (A8). Shared plugin code, public contracts and
   plugin processes remain independently versioned repositories. A Wails service extends the host and
   cannot be switched off as a plugin. These are different kinds, so they are different folders.
3. An upstream release is pinned. Wails Go, CLI, and frontend runtime dependencies use exact release versions, and moving them is legislation with its
   own commit, not a side effect (see NATIVE-LAYER.md).
4. `backup/` is invisible to every build and gate. Anything the build needs is not in it.

A repository under `forks/` has one remote and branch contract: `origin` names the maintained fork,
and `upstream` names the original repository. The branch name includes the upstream version it
extends. A temporary feature branch is folded into that version branch after GREEN and removed; two
branches must not carry the same maintained release line.

The workspace layout is an authoring layout, not runtime discovery. The application resolves
plugins, sidecars, kits, contracts, and specs from `environment.json` and never scans these sibling
folders. A repository runs its own tests; cross-repository product tests use Core installation and
the same environment discovery path as the product.

The application does not depend on workspace-relative framework or frontend package paths.

## L1b. A message is owned by whatever it is about

One registry per owner, not one for everything. The application's sentences are in the application,
a plugin's or sidecar's are in its repository, and nothing outside a tree declares into that tree's registry.

The reason is not tidiness. A component that declared into an application's registry can only be used by
that application: its sentences are absent everywhere else, and what a person sees is a refusal with
no words in it. It also puts the wording in one place and the fact in another, so the two part the
day the application rewords something the component meant precisely.

So a component states the fact — which target, which operation, what was missing — and whoever embeds it
does the wording. Measured 2026-08-20: one host service's entire dependency on this application was
a single sentence declared into its registry.

`i18n_ownership_gate_test.go` reads the sibling trees for that import. It is one-directional on
purpose: this repository importing its own registry is what the registry is for.

## L1a. Material from another tree is copied in, and the copy decides where

A repository that came from somewhere else is copied into this workspace and the original upstream
is never written to. A maintained fork is written only through its `origin`; an unmodified external
is never written. Two reasons, and the second is the one that governs:

- A source tree that another application is running is not still while it is read. What a reading
  found once, a second reading may not find, and neither reading states which one is the record.
- A path that can be read is one keystroke from a path that can be written. A copy removes the
  write entirely, which no amount of care does.

Where the copy lands is decided by ownership. Product components go in the folder for their product
kind. A maintained upstream fork goes in `forks/`, an independently authored reusable library in
`libraries/`, unmodified comparison source in `externals/`, and product acceptance code in `tests/`.
Material retained only as history goes in `backup/`, which no build and no gate sees. None of these
workspace paths is a dependency locator.

**A produced artefact is never copied.** A binary carried in from another tree makes this workspace
appear to build something it cannot: the artefact runs, the gate that would have named the gap stays
green, and the producer is somewhere no clone reaches. What is copied is what produces the artefact,
or nothing.

**No symbolic link, in either direction.** A declared path is resolved as declared, and a failure
names every location it looked in. A link answers as though a file were somewhere it is not, and the
answer is indistinguishable from the file actually being there.

## L2. Inside the application

```
soksak-core/
├── main.go             embeds the frontend and enters the application composition
├── core/               framework-independent Go: no window, no vendor
├── internal/
│   ├── application/    bootstrap, home claim, process wiring, and lifecycle system gates
│   ├── repositorygate/ repository-wide source, document, build, and policy gates
│   └── repositoryroot/ checkout discovery from the go.mod marker
├── frameworks/wails/   this host: windows, capture, native surfaces, the service list
├── cmd/sok             the control-plane CLI
├── frontend/           the renderer
├── docs/               contracts (tech/) and procedures (manual/)
├── build/              packaging inputs
├── bin/                the two binaries this project produces: soksak, sok
```

`core/` never names a framework or a plugin, and `go test ./core/...` answers commands with no
window. `frameworks/wails/` may name both — it is the only package that can.

`main.go` is the only Go file at the repository root. Embed paths cannot climb above their source
directory, so it owns the frontend embed and passes the resulting filesystem to
`internal/application`. Application bootstrap and lifecycle gates live together; repository-wide
gates run from their own package and discover the checkout by walking up to `go.mod`. A gate never
depends on being placed beside the files it inspects.

## L3. Two binaries, no more

`bin/soksak` is the application. `bin/sok` is the control-plane client. A third name in `bin/`
means a build that nobody will remember tomorrow; a gate refuses any Go binary at the repository
root.

## L4. Where a document goes

`docs/tech/` holds contracts. `docs/manual/` holds procedures. `docs/investigations/<topic>/` holds
hypotheses, and its conclusion moves into a contract when it settles.

Every canonical document is English. Korean exists only in `ko` resource values and paired `.ko.md`
translations that identify their English canonical (AGENTS 6-1).
`docs/README.md` is the register, and a document that is not in it does not exist.
