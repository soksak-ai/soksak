# Application release

The Core application version has one source: `frontend/package.json`. Pushing its matching `v*` tag
runs the Wails release workflow from that tagged commit. The workflow finds a successful
`windows-terminal-system` run for the exact same commit and downloads the `soksak.exe` and
`sok.exe` bytes tested by that run; it does not rebuild and substitute different bytes after native
verification.

The packager publishes a deterministic Windows x86_64 ZIP, `SHA256SUMS`, and a provenance document
that names the source commit, native system run, platform, architecture, archive inventory, and
Authenticode state. Version and tag are derived from the source package file. The workflow refuses
an existing tag and requires owner-enforced immutable releases before publication.

Version `0.0.1` has no Windows Authenticode credential. Its provenance and release notes therefore
state `unsigned`; the release never implies an identified publisher. Adding an Authenticode
certificate requires a new version, signed-byte verification, and a provenance state change.

macOS Go commands use one 10.15 deployment target for every cgo compile and final link. The link
gate starts with an empty Go cache and rejects linker warnings. Apple's linker may receive the
Objective-C runtime through more than one framework-backed cgo package; the build disables only
that duplicate-library diagnostic after keeping every object on the same deployment target.
