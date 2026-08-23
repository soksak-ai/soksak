# Application release

The Core application version has one source: root `VERSION`. `frontend/package.json` and the
Windows, macOS, and Linux package metadata are exact projections checked by tests. The release
matrix is Windows x86_64, macOS universal, Linux x86_64, and Linux arm64; the packager rejects a
partial matrix and inspects PE, fat Mach-O, and ELF architectures before writing archives.

Go has one version source per repository: the exact `go` directive in `go.mod`. Docker, Actions,
and shell gates read it rather than copying the literal. Frontend Node and pnpm versions live in
`frontend/package.json`; one pinned frontend container writes an input digest beside `dist`, and
every target consumes the same bytes. Cross images are target-architecture images. Linux uses the
declared Ubuntu 24.04 GTK4/WebKit 6.0 SDK; the release record includes the observed GLIBC maximum.

The macOS application is built natively into x86_64 and arm64 slices, joined as a universal app,
and ad-hoc signed. Its Intel slice targets macOS 10.15 and its Apple Silicon slice targets macOS
11.0. The Go control client uses the Go 1.26 internal-linker baseline of macOS 12.0 for both slices.
The native command rejects linker warnings and verifies every deployment target and signature.

Each platform archive records its native system run, architecture, inventory, and signing state.
`SHA256SUMS` covers all four archives, provenance, and both release notes. Publication refuses a
partial matrix or an existing tag and requires owner-enforced immutable releases. Windows and
Linux are unsigned; macOS is ad-hoc signed, not Developer ID signed or notarized.

The macOS link gate starts with an empty Go cache and rejects linker warnings. Apple's linker may
receive the Objective-C runtime through more than one framework-backed cgo package; the build
disables only that duplicate-library diagnostic while keeping each slice on its declared target.

## Published v0.0.2 evidence

Tag `v0.0.2` names source commit `badc426cff97cca1b8dd9b2e67e31e62c11fe40e`. Native system run
`32644742653` built and passed the installed fleet on Windows x86_64, macOS, Linux x86_64, and
Linux arm64. Release run `32645366005` consumed only those tested artifacts and published the four
archives, `SHA256SUMS`, provenance, and English/Korean release notes as an immutable release.
