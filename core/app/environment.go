// Package app answers what this installation is.
//
// Everything here is derived from values the caller passes in. Nothing reads the
// process environment, so a window, a headless server, and a test all get the
// same answer from the same input.
package app

import "github.com/soksak-ai/soksak-core/core/identity"

// Environment is what the frontend requests first: which installation is this,
// where does it live, and what is it allowed to do.
type Environment struct {
	Identity   string `json:"identity"`
	Home       string `json:"home"`
	Runtime    string `json:"runtime"`
	CoreBuild  string `json:"coreBuild"`
	CLI        string `json:"cli"`
	LoginShell string `json:"loginShell"`
	// BuildProfile is how this binary was compiled, which is a different fact
	// from CoreBuild: a debug build can run the release identity.
	BuildProfile string `json:"buildProfile"`
	// UpdaterEnabled follows the release axis. A dev installation offering to
	// update itself would replace it with the release one.
	UpdaterEnabled bool `json:"updaterEnabled"`
}

// Describe builds the environment from one resolved identity.
//
// Taking the whole Resolved rather than an identifier keeps the pair from
// drifting: there is no path here that could pair one installation's home with
// another's name.
func Describe(id identity.Resolved, buildProfile, loginShell string) Environment {
	return Environment{
		Identity:       id.Identifier,
		Home:           id.Home,
		Runtime:        id.Runtime,
		CoreBuild:      id.CoreBuild,
		CLI:            id.CLI,
		LoginShell:     loginShell,
		BuildProfile:   buildProfile,
		UpdaterEnabled: id.Release,
	}
}
