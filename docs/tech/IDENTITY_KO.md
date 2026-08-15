---
kind: canonical
status: active
canonical: IDENTITY.md
---

# Identity

English canonical: [`IDENTITY.md`](IDENTITY.md). Where the two differ, English wins.

Which installation a process is part of, and everything that follows from it.

## I1. One input, one derivation

`core/identity` takes an identifier (`com.soksak.wails.dev`) and the ambient the caller read, and returns home, socket path,
CLI name, build axis and release flag together.

Deriving them separately makes the pair ("home A, identifier B") representable, and a reconnect then lands on another installation with nothing
with nothing reported. Deriving them in one function removes the combination instead of checking for it afterwards.

## I2. The core does not read ambient

`core/` does not call `os.Getenv`, `os.Getwd` or `os.Executable`, and does not branch on `runtime.GOOS`
does not. The launcher reads them and passes values — `identity.Environment{Windows, Home, UserProfile}`.

Two consequences, both required. The same rules answer the same way in a window, in a headless server and in a test.
And a misconfigured process cannot inherit the release user's home.

**Gate.** `core/install/ambient_test.go` scans the core source for ambient reads.

## I3. Two axes

An identifier splits into a framework axis and an environment axis. `com.soksak.dev` has no framework axis —
The `soksak` segment is the product name. `com.soksak.wails.dev` has both.

`release` and `app` are the release axis. Everything else is a separate installation.

## I4. What follows from the axes

| Derived | release | Other axis (e.g. `dev`) |
| --- | --- | --- |
| home | `~/.soksak` | `~/.soksak-dev` |
| socket | `<home>/<identifier>.sock` | same rule |
| CLI name | `sok` | `sok-dev` |

Homes stand side by side, so a new environment gets its own without being registered anywhere.

There is no runtime override. A home that can be swapped while the process runs is a home two processes can disagree about, and
SQLite does not refuse a second writer — it serialises, so the collision stays silent. Measured 2026-08-15:
an identifier on the `dev` axis opened `~/.soksak-dev/soksak.db` while another process's socket was in that directory
was alive.

## I5. Identity is not invented

`identity.Require` refuses an empty identifier instead of defaulting. Guessing its own identity
attaches a process to a different installation the moment the guess is wrong, and it does so silently.

## I6. One backend per home

The home is claimed before the store is opened or a window is drawn (`launch.go`). A second process for the same home
exits before it draws anything, so the failure is "one refused start", not "two backends writing one database"
is not.
