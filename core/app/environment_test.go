package app

import (
	"encoding/json"
	"path/filepath"
	"testing"

	"github.com/soksak-ai/soksak-core/core/identity"
)

func resolved(t *testing.T, id string) identity.Resolved {
	t.Helper()
	got, err := identity.Require(id, identity.Environment{Home: "/tmp/user"})
	if err != nil {
		t.Fatalf("resolving %q: %v", id, err)
	}
	return got
}

func TestEnvironmentExposesTheResolvedRuntimeDirectory(t *testing.T) {
	id, err := identity.Require("com.soksak.capture", identity.Environment{
		Home:    "/tmp/user",
		Runtime: "/tmp/soksak-capture-runtime",
	})
	if err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(Describe(id, "debug", "/bin/zsh", "soksakv3"))
	if err != nil {
		t.Fatal(err)
	}
	var values map[string]any
	if err := json.Unmarshal(body, &values); err != nil {
		t.Fatal(err)
	}
	if values["runtime"] != "/tmp/soksak-capture-runtime" {
		t.Fatalf("runtime = %#v", values["runtime"])
	}
	if values["processLabel"] != "soksakv3" {
		t.Fatalf("process label = %#v", values["processLabel"])
	}
}

func TestEnvironmentReportsOneResolvedIdentity(t *testing.T) {
	env := Describe(resolved(t, "com.soksak.dev"), "debug", "/bin/zsh", "soksak-dev")

	if env.Identity != "com.soksak.dev" {
		t.Errorf("identity = %q", env.Identity)
	}
	if env.Home != filepath.Join("/tmp/user", ".soksak-dev") {
		t.Errorf("home = %q", env.Home)
	}
	if env.CoreBuild != "dev" {
		t.Errorf("core build = %q", env.CoreBuild)
	}
	if env.CLI != "sok-dev" {
		t.Errorf("cli = %q", env.CLI)
	}
	if env.BuildProfile != "debug" {
		t.Errorf("build profile = %q", env.BuildProfile)
	}
	if env.LoginShell != "/bin/zsh" {
		t.Errorf("login shell = %q", env.LoginShell)
	}
	if env.ProcessLabel != "soksak-dev" {
		t.Errorf("process label = %q", env.ProcessLabel)
	}
}

func TestUpdaterFollowsTheReleaseAxis(t *testing.T) {
	// A dev installation must not offer to update itself into the release one.
	if Describe(resolved(t, "com.soksak.dev"), "debug", "/bin/zsh", "soksak").UpdaterEnabled {
		t.Error("a dev identity must not enable the updater")
	}
	if !Describe(resolved(t, "com.soksak.app"), "release", "/bin/zsh", "soksak").UpdaterEnabled {
		t.Error("a release identity must enable the updater")
	}
}
