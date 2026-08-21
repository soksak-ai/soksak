package app

import (
	"path/filepath"
	"testing"

	"github.com/soksak/soksak-core/core/identity"
)

func resolved(t *testing.T, id string) identity.Resolved {
	t.Helper()
	got, err := identity.Require(id, identity.Environment{Home: "<local-evidence>/user"})
	if err != nil {
		t.Fatalf("resolving %q: %v", id, err)
	}
	return got
}

func TestEnvironmentReportsOneResolvedIdentity(t *testing.T) {
	env := Describe(resolved(t, "com.soksak.dev"), "debug", "/bin/zsh")

	if env.Identity != "com.soksak.dev" {
		t.Errorf("identity = %q", env.Identity)
	}
	if env.Home != filepath.Join("<local-evidence>/user", ".soksak-dev") {
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
}

func TestUpdaterFollowsTheReleaseAxis(t *testing.T) {
	// A dev installation must not offer to update itself into the release one.
	if Describe(resolved(t, "com.soksak.dev"), "debug", "/bin/zsh").UpdaterEnabled {
		t.Error("a dev identity must not enable the updater")
	}
	if !Describe(resolved(t, "com.soksak.app"), "release", "/bin/zsh").UpdaterEnabled {
		t.Error("a release identity must enable the updater")
	}
}

func TestUnitModeIsOfficialWithNoDevelopmentUnits(t *testing.T) {
	env := Describe(resolved(t, "com.soksak.app"), "release", "/bin/zsh")

	if env.UnitMode != "official" {
		t.Errorf("unit mode = %q, want official", env.UnitMode)
	}
	// The frontend iterates these. A nil slice serialises as null and makes the
	// consumer branch on absence instead of emptiness.
	if env.DevelopmentUnits == nil || env.RejectedDevelopmentUnits == nil {
		t.Error("unit lists must serialise as empty arrays, never null")
	}
}
