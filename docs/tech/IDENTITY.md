---
kind: canonical
status: active
canonical: self
---

# Identity


Which installation a process is owned by, and everything that follows from it.

## I1. One input, one derivation

`core/identity` takes an identifier (`com.soksakv3.core`) and the ambient the caller read, and
returns home, socket path, CLI name, build axis and release flag together.

Deriving them separately makes the pair ("home A, identifier B") representable, and a reconnect then
lands on another installation with nothing reported. Deriving them in one function removes the
combination instead of checking for it afterwards.

## I2. The core reads no ambient

`core/` calls no `os.Getenv`, `os.Getwd` or `os.Executable`, and does not branch on `runtime.GOOS`.
The launcher reads those and passes values: `identity.Environment{Windows, Home, UserProfile}`.

Two consequences, both required: the same rules answer the same way in a window, in a headless
server and in a test; and a misconfigured process cannot inherit the release user's home.

**Gate.** `core/install/ambient_test.go` scans core sources for ambient reads.

## I3. Project identity

A built project has identifier `com.<project>.core`. The middle segment is the stable project name;
`core` is the application kind, not a home suffix or a framework axis. `com.soksak.core` and
`com.soksakv3.core` are different projects and share no persistent state.

An explicitly addressed development or gate process may use an environment-axis identifier such as
`com.soksak.dev`. That is a run identity, not a built project. A framework name never participates
in project identity.

## I4. What follows from the axis

| Derived | `com.soksak.core` | `com.soksakv3.core` | Explicit run `com.soksak.dev` |
| --- | --- | --- | --- |
| home | `~/.soksak` | `~/.soksakv3` | `~/.soksak-dev` |
| environment | `<home>/environment.json` | same rule | same rule |
| socket | `<home>/<identifier>.sock` | same rule | same rule |
| CLI name | `sok` | `sokv3` | `sok-dev` |

Project homes sit side by side and require no registration table.

There is no runtime override. A home that can be swapped while the process runs is a home two
processes can disagree about, and SQLite does not refuse a second writer — it serialises, so the
collision stays silent. Measured 2026-08-15: an identifier on the `dev` axis opened
`~/.soksak-dev/soksak.db` while another process held live sockets in that directory.

## I5. An identity is never invented

`identity.Require` refuses an empty identifier instead of defaulting. A process that guesses its
identity attaches to a different installation the moment the guess is wrong, and it does so
silently.

## I6. One backend per home

The home is claimed before the store is opened or a window is drawn
(`internal/application/launch.go`). A second process
for the same home exits before it can draw anything, so the failure is one refused start rather than
two backends writing one database.

## I7. One composition per identity

The home owns one settings composition (COMPOSITION C2). Release, development and test identities
never share install selection, development mode or provider bindings. An installer transaction and
the backend that resolves it therefore use the same resolved identity home.
