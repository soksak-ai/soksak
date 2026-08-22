// Package identity derives everything a process needs to know about which
// installation it is part of, from one input.
//
// Nothing here reads the process environment. The caller passes what it read,
// so the same rules answer the same way in a window, in a headless server, and
// in a test — and so a misconfigured process cannot quietly inherit the release
// user's home.
package identity

import (
	"path/filepath"
	"strings"

	controlwire "github.com/soksak-ai/soksak-contract-control"
	"github.com/soksak-ai/soksak-core/core/i18n"
)

const product = "soksak"

// Environment is the ambient the caller read, passed as a value.
type Environment struct {
	Windows     bool
	Home        string
	UserProfile string
	// Persistent is an optional exact identity home. It is never suffixed or guessed.
	Persistent string
	// Runtime is an optional absolute directory for ephemeral endpoints such as the control socket.
	// Persistent state still derives only from Home and the identifier. Keeping the two roots in one
	// resolved value prevents callers from mixing identities while allowing short Unix socket paths.
	Runtime string
}

// Resolved is one identity, derived once.
//
// Reading the identifier and the home through separate paths leaves
// the pair ("A home, B identifier") representable, and a reconnect can
// land on the wrong one. Deriving both together removes the combination rather
// than checking for it afterwards.
type Resolved struct {
	Identifier string
	Home       string
	// Runtime is the absolute root for ephemeral endpoints. Persistent state never uses it.
	Runtime string
	// Socket is where this installation's app binds. Derived here so two
	// spellings cannot drift; a drift reads only as "connection failed".
	Socket string
	// CoreBuild is the environment axis: release, dev, debug, …
	CoreBuild string
	// CLI is the command name this installation answers to.
	CLI     string
	Release bool
}

// AxesOf splits an identifier into its framework and environment axes.
//
// `com.soksak.dev` has no framework axis: the `soksak` segment names the
// product. `com.soksak.wails.dev` does.
func AxesOf(identifier string) (framework string, env string) {
	segments := make([]string, 0, 4)
	for _, segment := range strings.Split(identifier, ".") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	switch len(segments) {
	case 0:
		return "", "release"
	case 1:
		return "", segments[0]
	default:
		env = segments[len(segments)-1]
		candidate := segments[len(segments)-2]
		if len(segments) >= 4 && candidate != product {
			return candidate, env
		}
		return "", env
	}
}

func isRelease(env string) bool { return env == "release" || env == "app" }

// HomeFor derives the installation home. Identity homes live side by side
// (~/.soksak, ~/.soksak-dev, …), so a new environment gets its own home without
// anything being listed anywhere.
//
// There is no runtime override: the home follows from the identifier and
// nothing else. A home that can be swapped at runtime is a home two processes
// can disagree about.
func HomeFor(identifier string, env Environment) string {
	base := env.Home
	if env.Windows && base == "" {
		// Windows commonly leaves HOME unset. An empty base would put the vault
		// and the database at a cwd-relative `.soksak`, making the store depend
		// on the working directory.
		base = env.UserProfile
	}
	_, axis := AxesOf(identifier)
	suffix := ""
	if !isRelease(axis) {
		suffix = "-" + axis
	}
	return filepath.Join(base, ".soksak"+suffix)
}

// Resolve derives one identity. Callers that cannot supply an identifier should
// use Require instead of passing an empty string.
func Resolve(identifier string, env Environment) Resolved {
	_, axis := AxesOf(identifier)
	release := isRelease(axis)

	cli := "sok"
	if !release {
		cli = "sok-" + axis
	}

	home := HomeFor(identifier, env)
	if env.Persistent != "" {
		home = env.Persistent
	}
	runtimeRoot := home
	if env.Runtime != "" {
		runtimeRoot = env.Runtime
	}
	controlAddress := controlwire.Address(runtimeRoot, identifier, env.Windows)
	return Resolved{
		Identifier: identifier,
		Home:       home,
		Runtime:    runtimeRoot,
		Socket:     controlAddress,
		CoreBuild:  axis,
		CLI:        cli,
		Release:    release,
	}
}

// Require resolves an identity, refusing to invent one.
//
// A process that guesses its identity attaches to a different installation the
// moment the guess is wrong, and it does so silently.
func Require(identifier string, env Environment) (Resolved, error) {
	if identifier == "" {
		return Resolved{}, i18n.Errorf("identity.require.noIdentifier", nil)
	}
	if env.Runtime != "" && !filepath.IsAbs(env.Runtime) {
		return Resolved{}, i18n.Errorf("identity.require.runtimeNotAbsolute", map[string]string{"path": env.Runtime})
	}
	if env.Persistent != "" && !filepath.IsAbs(env.Persistent) {
		return Resolved{}, i18n.Errorf("identity.require.persistentNotAbsolute", map[string]string{"path": env.Persistent})
	}
	return Resolve(identifier, env), nil
}
