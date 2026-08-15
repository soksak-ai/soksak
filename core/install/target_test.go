package install

import (
	"strings"
	"testing"
)

// TestEachHostNamesItsOwnTriple is the whole table. The value selects which
// archive a unit's release hands over, so a wrong one does not fail at
// selection — it downloads, installs, and fails when the binary is executed.
func TestEachHostNamesItsOwnTriple(t *testing.T) {
	for _, want := range []struct{ goos, goarch, triple string }{
		{"darwin", "arm64", "aarch64-apple-darwin"},
		{"darwin", "amd64", "x86_64-apple-darwin"},
		{"linux", "arm64", "aarch64-unknown-linux-gnu"},
		{"linux", "amd64", "x86_64-unknown-linux-gnu"},
		{"windows", "arm64", "aarch64-pc-windows-msvc"},
		{"windows", "amd64", "x86_64-pc-windows-msvc"},
	} {
		got, err := hostUnitTarget(want.goos, want.goarch)
		if err != nil {
			t.Errorf("%s/%s: %v", want.goos, want.goarch, err)
			continue
		}
		if got != want.triple {
			t.Errorf("%s/%s = %q, want %q", want.goos, want.goarch, got, want.triple)
		}
	}
}

// TestTheAnswerFollowsTheArgumentNotThisBuild is the evidence that nothing here
// reads runtime.GOOS: one build gives six different answers, which a body that
// described itself could not do.
func TestTheAnswerFollowsTheArgumentNotThisBuild(t *testing.T) {
	seen := map[string]bool{}
	for _, pair := range [][2]string{
		{"darwin", "arm64"}, {"darwin", "amd64"},
		{"linux", "arm64"}, {"linux", "amd64"},
		{"windows", "arm64"}, {"windows", "amd64"},
	} {
		triple, err := hostUnitTarget(pair[0], pair[1])
		if err != nil {
			t.Fatalf("%v: %v", pair, err)
		}
		if seen[triple] {
			t.Fatalf("%v answered %q, which another host already answered — two hosts sharing one triple means one of them gets the other's binary", pair, triple)
		}
		seen[triple] = true
	}
}

// TestAnUnknownHostGetsNoInventedTriple keeps the failure at the point where it
// can still be read. A plausible triple for a host nobody publishes for
// downloads successfully and dies on exec, which reads as a broken plugin
// rather than as an unsupported machine.
func TestAnUnknownHostGetsNoInventedTriple(t *testing.T) {
	for _, pair := range [][2]string{
		{"linux", "riscv64"},
		{"freebsd", "amd64"},
		{"darwin", "386"},
	} {
		triple, err := hostUnitTarget(pair[0], pair[1])
		if err == nil {
			t.Errorf("%v was given the invented triple %q", pair, triple)
			continue
		}
		if !strings.Contains(err.Error(), pair[0]) || !strings.Contains(err.Error(), pair[1]) {
			t.Errorf("%v: the refusal does not carry the host: %v", pair, err)
		}
	}
}

// TestAMissingPlatformIsRefusedByName. An empty pair is a launcher that did not
// fill the field in, and answering some default would make every host on that
// build install one host's binaries.
func TestAMissingPlatformIsRefusedByName(t *testing.T) {
	for _, pair := range [][2]string{{"", "arm64"}, {"darwin", ""}, {"", ""}} {
		_, err := hostUnitTarget(pair[0], pair[1])
		if err == nil {
			t.Errorf("%v was accepted", pair)
			continue
		}
		if !strings.Contains(err.Error(), "install.Deps.OS") {
			t.Errorf("%v: the refusal does not name what to supply: %v", pair, err)
		}
	}
}
