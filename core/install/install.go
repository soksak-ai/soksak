// Package install answers what is installed on this machine, where, and what
// this build is — and refuses, by name, the parts of installation that have no
// owner here.
//
// The split is not arbitrary. Observation (is this launcher there, does it run,
// where does npm put things, which artifact triple names this host) is pure disk
// and pure process, and every input arrives as an argument. Acquisition (fetch a
// release archive, extract it, publish a generation, scaffold a unit and declare
// it) needs two things this build does not have: a loader that reads a unit
// directory, and a served unit_source_set. Those refusals live in unbuilt.go with
// the fact that blocks each one.
//
// Nothing here reads the environment. The home, the platform, the login shell,
// and the runner all arrive as values, so the same command answers the same way
// in a window, in a headless server, and in a test.
package install

import (
	"github.com/soksak/soksak-core/core/control"
	"github.com/soksak/soksak-core/core/files"
)

// Deps is what the process supplies. Every field is something this package
// refuses to read for itself.
type Deps struct {
	// Home is the installation's home — identity.Resolved.Home, never the OS
	// user's home. theme_install writes under it, beside what themes_scan
	// reads. Empty refuses theme_install by name rather than picking a
	// directory, because a theme written somewhere nobody scans is an install
	// that reports success and changes nothing.
	Home string

	// OS and Arch name the host this build was made for, in Go's spelling:
	// "darwin"/"linux"/"windows" and "arm64"/"amd64". Reading runtime.GOOS
	// here would answer what this binary is rather than what the caller asked,
	// and would make the same source unable to show two hosts at once. Either
	// one empty refuses host_unit_target by name.
	OS   string
	Arch string

	// LoginShell is the shell npm_global_dirs queries. Empty refuses that command
	// by name rather than guessing $SHELL, which would tie the answer to
	// whatever launched this process. The `-l` in the argv is what makes the
	// answer the user's: the login shell rebuilds PATH from rc/profile, so a
	// GUI-launched process reports what the user's terminal reports.
	LoginShell string

	// Run starts a program and waits. Nil refuses probe_binary and
	// npm_global_dirs by name.
	//
	// This is files.Runner rather than a second interface of the same shape
	// because there is one rule in this build for "the program could not be
	// started" versus "the program ran and failed", and it is written there.
	// Two copies of that seam would let two groups disagree about which of the
	// two a missing shell is — and that disagreement arrives as "nothing is
	// installed" rather than as an error.
	Run files.Runner
}

// Register adds this group's six commands and declares its seven refusals.
//
// Every served command is OwnerCore: none needs a window, which is what lets
// `sok binary_integrity` answer identically to the same call from a page.
func Register(registry *control.Registry, deps Deps) {
	registry.MustRegister(control.Command{
		Name: "binary_integrity",
		Handler: func(args control.Args) (any, error) {
			binPath, err := control.Arg[string](args, "binPath")
			if err != nil {
				return nil, err
			}
			libPath, err := control.Arg[string](args, "libPath")
			if err != nil {
				return nil, err
			}
			return binaryIntegrity(binPath, libPath)
		},
	})

	registry.MustRegister(control.Command{
		Name: "probe_binary",
		Handler: func(args control.Args) (any, error) {
			bin, err := control.Arg[string](args, "bin")
			if err != nil {
				return nil, err
			}
			// Absent and [] are one answer: the caller ran the binary with no
			// arguments. A probe declaration whose argv is a single word
			// arrives here with nothing after it.
			probeArgs, err := control.OptionalArg[[]string](args, "args", nil)
			if err != nil {
				return nil, err
			}
			return probeBinary(bin, probeArgs, deps.Run)
		},
	})

	registry.MustRegister(control.Command{
		Name: "npm_global_dirs",
		Handler: func(control.Args) (any, error) {
			return npmGlobalDirs(deps.LoginShell, deps.OS, deps.Run)
		},
	})

	registry.MustRegister(control.Command{
		Name: "host_unit_target",
		Handler: func(control.Args) (any, error) {
			return hostUnitTarget(deps.OS, deps.Arch)
		},
	})

	registry.MustRegister(control.Command{
		Name: "theme_install",
		Handler: func(args control.Args) (any, error) {
			path, err := control.Arg[string](args, "path")
			if err != nil {
				return nil, err
			}
			return installTheme(deps.Home, path)
		},
	})

	registry.MustRegister(control.Command{
		Name: "unit_source_list",
		Handler: func(control.Args) (any, error) {
			return readDevSources(deps.Home)
		},
	})

	registry.MustRegister(control.Command{
		Name: "unit_source_set",
		Handler: func(args control.Args) (any, error) {
			kind, err := control.Arg[string](args, "kind")
			if err != nil {
				return nil, err
			}
			id, err := control.Arg[string](args, "id")
			if err != nil {
				return nil, err
			}
			source, err := control.Arg[string](args, "source")
			if err != nil {
				return nil, err
			}
			return writeDevSource(deps.Home, DevSource{Kind: kind, ID: id, Source: source})
		},
	})

	registry.MustRegister(control.Command{
		Name: "unit_source_validate",
		Handler: func(args control.Args) (any, error) {
			source, err := control.Arg[string](args, "source")
			if err != nil {
				return nil, err
			}
			return validateDevSource(source)
		},
	})

	for _, refusal := range unbuilt {
		if err := registry.DeclareUnserved(refusal.name, refusal.blockedBy); err != nil {
			// A refusal that cannot be declared is a programming fact at boot,
			// the same as a name registered twice.
			panic(err)
		}
	}
}
