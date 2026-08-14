package identity

import (
	"path/filepath"
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
		// A framework axis never reaches the home: one home, many hosts.
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
	// An earlier build read identifier and home separately, so the pair
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
