// Package app answers what this installation is.
//
// Everything here is derived from values the caller passes in. Nothing reads the
// process environment, so a window, a headless server, and a test all get the
// same answer from the same input.
package app

import "github.com/soksak/soksak-core/core/identity"

// DevelopmentUnit is a locally sourced plugin or sidecar.
type DevelopmentUnit struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Source string `json:"source"`
}

// Environment is what the frontend requests first: which installation is this,
// where does it live, and what is it allowed to do.
type Environment struct {
	Identity  string `json:"identity"`
	Home      string `json:"home"`
	CoreBuild string `json:"coreBuild"`
	CLI       string `json:"cli"`
	// BuildProfile is how this binary was compiled, which is a different fact
	// from CoreBuild: a debug build can run the release identity.
	BuildProfile string `json:"buildProfile"`
	// UpdaterEnabled follows the release axis. A dev installation offering to
	// update itself would replace it with the release one.
	UpdaterEnabled bool   `json:"updaterEnabled"`
	UnitMode       string `json:"unitMode"`
	// DevelopmentUnits and RejectedDevelopmentUnits are never nil: the frontend
	// iterates them, and null would make it branch on absence rather than
	// emptiness.
	DevelopmentUnits []DevelopmentUnit `json:"developmentUnits"`
	// RejectedDevelopmentUnits are declarations refused at the read boundary,
	// carried so the operator can clean up what was left behind.
	RejectedDevelopmentUnits []DevelopmentUnit `json:"rejectedDevelopmentUnits"`
}

// Describe builds the environment from one resolved identity.
//
// Taking the whole Resolved rather than an identifier keeps the pair from
// drifting: there is no path here that could pair one installation's home with
// another's name.
func Describe(id identity.Resolved, buildProfile string) Environment {
	units := []DevelopmentUnit{}
	rejected := []DevelopmentUnit{}

	mode := "official"
	if len(units) > 0 {
		mode = "mixed"
	}

	return Environment{
		Identity:                 id.Identifier,
		Home:                     id.Home,
		CoreBuild:                id.CoreBuild,
		CLI:                      id.CLI,
		BuildProfile:             buildProfile,
		UpdaterEnabled:           id.Release,
		UnitMode:                 mode,
		DevelopmentUnits:         units,
		RejectedDevelopmentUnits: rejected,
	}
}
