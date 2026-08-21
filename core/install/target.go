package install

import "github.com/soksak-ai/soksak-core/core/i18n"

// hostUnitTarget names the artifact triple for this host.
//
// A unit's release holds one archive per target, and this is the key that
// selects among them. An invented key does not fail at selection — it succeeds,
// downloads, and fails when the binary is executed, which reads as a broken
// plugin rather than as an unsupported host. So an unknown pair is refused
// carrying the pair.
//
// The platform arrives as an argument. `runtime.GOOS` here would answer what
// this binary is rather than what the caller asked, and the difference between
// the two is invisible until a build is cross-compiled.
//
// The limit of this table, so the next reader does not find it by shipping a
// broken install: the vocabulary has both -gnu and -musl for Linux, and
// (GOOS, GOARCH) cannot tell them apart — a Go binary built with CGO_ENABLED=0
// links neither. -gnu is named because glibc is what mainstream distributions
// run. The day a musl distribution exists, the triple stops being derivable
// from the pair at all and has to arrive as a value on Deps.
func hostUnitTarget(goos string, goarch string) (string, error) {
	if goos == "" || goarch == "" {
		return "", i18n.Errorf("install.hostUnitTarget.noPlatform", nil)
	}
	// The vocabulary is the plugin spec's UNIT_TARGETS; every value below is in
	// it. A triple that is not in that list would be rejected by the caller
	// anyway, and rejected as "unknown target" rather than as "this host has no
	// artifact" — two different repairs.
	//
	// Recorded 2026-08-15. One shipped answer for this axis is
	// x86_64-pc-windows-msvc for every Windows arch, on the ground that a
	// release channel ships one Windows build that arm64 emulates. That is a
	// statement about a distribution, and this build has no distribution to
	// make it about. Naming each host for itself is the answer that stays true
	// when the release channel arrives, whatever it publishes.
	switch goos + "/" + goarch {
	case "darwin/arm64":
		return "aarch64-apple-darwin", nil
	case "darwin/amd64":
		return "x86_64-apple-darwin", nil
	case "linux/arm64":
		return "aarch64-unknown-linux-gnu", nil
	case "linux/amd64":
		return "x86_64-unknown-linux-gnu", nil
	case "windows/arm64":
		return "aarch64-pc-windows-msvc", nil
	case "windows/amd64":
		return "x86_64-pc-windows-msvc", nil
	}
	return "", i18n.Errorf("install.hostUnitTarget.noTriple", map[string]string{"os": goos, "arch": goarch})
}
