package environment

import "github.com/soksak-ai/soksak-core/core/i18n"

// HostArtifactTarget returns the artifact triple for one host.
//
// A native artifact release holds one archive per target; this key selects
// among them. An unknown pair is refused with the pair named: an invented key
// downloads, installs, and fails at exec, which reads as a broken unit rather
// than an unsupported host.
//
// The platform arrives as an argument. runtime.GOOS would answer what this
// binary is rather than what the caller passed, and the difference is invisible
// until a build is cross-compiled.
//
// Limit of this table: the vocabulary has both -gnu and -musl for Linux, and
// (GOOS, GOARCH) cannot separate them. -gnu is named because mainstream
// distributions run glibc. A musl host requires the triple to arrive as a value.
func HostArtifactTarget(goos string, goarch string) (string, error) {
	if goos == "" || goarch == "" {
		return "", i18n.Errorf("install.hostArtifactTarget.noPlatform", nil)
	}
	// The vocabulary is the plugin spec's UNIT_TARGETS; every value below is in
	// it. Each host is named for itself; recorded 2026-08-15 that one shipped
	// channel maps every Windows arch to x86_64-pc-windows-msvc, which is a
	// statement about that distribution and not about the host.
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
	return "", i18n.Errorf("install.hostArtifactTarget.noTriple", map[string]string{"os": goos, "arch": goarch})
}
