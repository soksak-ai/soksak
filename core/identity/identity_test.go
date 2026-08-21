package identity

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestAxesOfIdentifier(t *testing.T) {
	cases := []struct {
		identifier string
		framework  string
		env        string
	}{
		{"", "", "release"},
		{"app", "", "app"},
		{"com.soksak.dev", "", "dev"},
		{"com.soksak.app", "", "app"},
		// The `soksak` in `com.soksak.dev` names the product, not a framework.
		{"com.soksak.wails.dev", "wails", "dev"},
	}
	for _, want := range cases {
		framework, env := AxesOf(want.identifier)
		if framework != want.framework || env != want.env {
			t.Errorf("AxesOf(%q) = (%q, %q), want (%q, %q)",
				want.identifier, framework, env, want.framework, want.env)
		}
	}
}

func TestHomeIsDerivedFromTheIdentifierAlone(t *testing.T) {
	base := filepath.Join("<local-evidence>", "user")
	cases := []struct {
		identifier string
		home       string
	}{
		{"com.soksak.app", filepath.Join(base, ".soksak")},
		{"com.soksak.dev", filepath.Join(base, ".soksak-dev")},
		{"com.soksak.debug", filepath.Join(base, ".soksak-debug")},
		// A framework axis never enters the home: one home, many hosts.
		{"com.soksak.wails.dev", filepath.Join(base, ".soksak-dev")},
	}
	for _, want := range cases {
		got := HomeFor(want.identifier, Environment{Home: base})
		if got != want.home {
			t.Errorf("HomeFor(%q) = %q, want %q", want.identifier, got, want.home)
		}
	}
}

func TestWindowsFallsBackToUserProfile(t *testing.T) {
	// Windows commonly leaves HOME unset. An empty base would put the vault and
	// the database at a cwd-relative `.soksak`, which is a different store on
	// every working directory.
	got := HomeFor("com.soksak.app", Environment{Windows: true, UserProfile: `C:\Users\max`})
	want := filepath.Join(`C:\Users\max`, ".soksak")
	if got != want {
		t.Errorf("HomeFor with only USERPROFILE = %q, want %q", got, want)
	}
}

func TestResolveReadsTheAmbientOnce(t *testing.T) {
	// Reading identifier and home separately makes the pair
	// ("A home, B identifier") was representable. Resolving once removes the
	// combination rather than checking for it.
	resolved := Resolve("com.soksak.dev", Environment{Home: "<local-evidence>/user"})

	if resolved.Identifier != "com.soksak.dev" {
		t.Fatalf("identifier = %q", resolved.Identifier)
	}
	if resolved.Home != filepath.Join("<local-evidence>/user", ".soksak-dev") {
		t.Errorf("home = %q", resolved.Home)
	}
	if resolved.CoreBuild != "dev" {
		t.Errorf("core build = %q, want dev", resolved.CoreBuild)
	}
	if resolved.CLI != "sok-dev" {
		t.Errorf("cli = %q, want sok-dev", resolved.CLI)
	}
	if resolved.Socket != filepath.Join(resolved.Home, "com.soksak.dev.sock") {
		t.Errorf("socket = %q", resolved.Socket)
	}
}

func TestRuntimeSocketCanBeSeparatedFromPersistentStateWithoutSplittingIdentity(t *testing.T) {
	resolved := Resolve("com.soksak.gate", Environment{
		Home:    "/workspace/.task/gates/123/1",
		Runtime: "<local-evidence>/soksak-gates/123/1",
	})
	if resolved.Home != "/workspace/.task/gates/123/1/.soksak-gate" {
		t.Fatalf("persistent state moved outside the declared gate root: %s", resolved.Home)
	}
	if resolved.Socket != "<local-evidence>/soksak-gates/123/1/com.soksak.gate.sock" {
		t.Fatalf("runtime endpoint did not use the declared short runtime root: %s", resolved.Socket)
	}
	if resolved.Runtime != "<local-evidence>/soksak-gates/123/1" {
		t.Fatalf("runtime root = %q", resolved.Runtime)
	}
}

func TestWindowsControlAddressUsesTheNamedPipeNamespace(t *testing.T) {
	resolved := Resolve("com.soksak.gate", Environment{Windows: true, UserProfile: `C:\Users\gate`, Runtime: `C:\run\gate`})
	if !strings.HasPrefix(resolved.Socket, `\\.\pipe\soksak-control-`) {
		t.Fatalf("Windows control address=%q", resolved.Socket)
	}
	if strings.Contains(resolved.Socket, `C:\run`) {
		t.Fatalf("Windows file path was used as a named pipe: %q", resolved.Socket)
	}
}

func TestExactPersistentHomeDoesNotReceiveAnIdentitySuffix(t *testing.T) {
	resolved, err := Require("com.soksak.gate", Environment{
		Home: "/Users/person", Persistent: "/workspace/gate-home", Runtime: "<local-evidence>/gate-runtime",
	})
	if err != nil {
		t.Fatal(err)
	}
	if resolved.Home != "/workspace/gate-home" {
		t.Fatalf("persistent home = %q", resolved.Home)
	}
}

func TestExactPersistentHomeMustBeAbsolute(t *testing.T) {
	if _, err := Require("com.soksak.gate", Environment{Persistent: "relative"}); err == nil {
		t.Fatal("relative persistent home was accepted")
	}
}

func TestReleaseCarriesNoSuffix(t *testing.T) {
	resolved := Resolve("com.soksak.app", Environment{Home: "<local-evidence>/user"})

	if resolved.Home != filepath.Join("<local-evidence>/user", ".soksak") {
		t.Errorf("home = %q, want the unsuffixed home", resolved.Home)
	}
	if resolved.CLI != "sok" {
		t.Errorf("cli = %q, want sok", resolved.CLI)
	}
	if !resolved.Release {
		t.Error("app identity should report release")
	}
}

func TestMissingIdentifierFailsRatherThanGuessing(t *testing.T) {
	// Deriving a default here would point a misconfigured process at the release
	// user's home and do it silently.
	if _, err := Require("", Environment{Home: "<local-evidence>/user"}); err == nil {
		t.Fatal("an empty identifier must fail by name")
	}
}

func TestThisInstallationDoesNotShareAnotherHome(t *testing.T) {
	// Homes are separated by the environment axis alone: a framework axis is
	// deliberately not part of it, because one home holds one backend and may
	// have several frontends.
	//
	// Measured 2026-08-15: an identifier on the `dev` axis opened
	// ~/.soksak-dev/soksak.db while another process held sockets in that directory.
	// The store is single-writer by design and SQLite does not refuse a second
	// writer — it serialises — so the collision would have stayed silent.
	const ours = "com.soksak.wails"
	home := HomeFor(ours, Environment{Home: "<local-evidence>/user"})

	for _, taken := range []string{"com.soksak.app", "com.soksak.dev", "com.soksak.debug"} {
		if HomeFor(taken, Environment{Home: "<local-evidence>/user"}) == home {
			t.Errorf("%s shares a home with %s: %s", ours, taken, home)
		}
	}
}
