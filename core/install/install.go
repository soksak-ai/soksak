// Package install provides host inspection and atomic artifact installation.
//
// Nothing here reads the environment. The home, the platform, the login shell,
// and the runner all arrive as values, so the same command answers the same way
// in a window, in a headless server, and in a test.
package install

import (
	"context"
	"path/filepath"

	"github.com/soksak-ai/soksak-core/core/control"
	"github.com/soksak-ai/soksak-core/core/environment"
	"github.com/soksak-ai/soksak-core/core/files"
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
	// one empty refuses host_artifact_target by name.
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

	Fetcher Fetcher
	Changed func(event string, payload any)
}

// Register adds this group's six commands and declares its seven refusals.
//
// Every served command is OwnerCore: none needs a window, which is what lets
// `sok binary_integrity` answer identically to the same call from a page.
func Register(registry *control.Registry, deps Deps) {
	var transactions *TransactionManager
	if deps.Home != "" && deps.Fetcher != nil {
		root := filepath.Join(deps.Home, ".transactions")
		if err := RecoverTransactions(deps.Home, root); err != nil {
			panic(err)
		}
		transactions = NewTransactionManager(root, deps.Fetcher)
	}
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

	if transactions != nil {
		registerInstallTransactions(registry, transactions, deps)
	}

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
		Name: "host_artifact_target",
		Handler: func(control.Args) (any, error) {
			return hostArtifactTarget(deps.OS, deps.Arch)
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

	for _, refusal := range unbuilt {
		if transactions != nil && isInstallTransactionCommand(refusal.name) {
			continue
		}
		if err := registry.DeclareUnserved(refusal.name, refusal.blockedBy); err != nil {
			// A refusal that cannot be declared is a programming fact at boot,
			// the same as a name registered twice.
			panic(err)
		}
	}
}

func isInstallTransactionCommand(name string) bool {
	return len(name) > len("artifact_install_") && name[:len("artifact_install_")] == "artifact_install_"
}

func registerInstallTransactions(registry *control.Registry, manager *TransactionManager, deps Deps) {
	registry.MustRegister(control.Command{Name: "artifact_install_begin", Handler: func(args control.Args) (any, error) {
		registryID, err := control.Arg[string](args, "registryId")
		if err != nil {
			return nil, err
		}
		root, err := control.Arg[ArtifactIdentity](args, "root")
		if err != nil {
			return nil, err
		}
		return manager.Begin(registryID, root)
	}})
	registry.MustRegister(control.Command{Name: "artifact_install_stage", Handler: func(args control.Args) (any, error) {
		transactionID, err := control.Arg[string](args, "transactionId")
		if err != nil {
			return nil, err
		}
		registryID, err := control.Arg[string](args, "registryId")
		if err != nil {
			return nil, err
		}
		identity, err := control.Arg[ArtifactIdentity](args, "identity")
		if err != nil {
			return nil, err
		}
		artifact, err := control.Arg[Artifact](args, "artifact")
		if err != nil {
			return nil, err
		}
		return manager.Stage(context.Background(), StageRequest{TransactionID: transactionID, RegistryID: registryID, Identity: identity, Artifact: artifact})
	}})
	registry.MustRegister(control.Command{Name: "artifact_install_read_utf8", Handler: func(args control.Args) (any, error) {
		transactionID, err := control.Arg[string](args, "transactionId")
		if err != nil {
			return nil, err
		}
		handle, err := control.Arg[string](args, "handle")
		if err != nil {
			return nil, err
		}
		path, err := control.Arg[string](args, "path")
		if err != nil {
			return nil, err
		}
		return manager.ReadUTF8(transactionID, handle, path)
	}})
	registry.MustRegister(control.Command{Name: "artifact_install_commit", Handler: func(args control.Args) (any, error) {
		transactionID, err := control.Arg[string](args, "transactionId")
		if err != nil {
			return nil, err
		}
		expected, err := control.Arg[uint64](args, "expectedRevision")
		if err != nil {
			return nil, err
		}
		components, err := control.Arg[[]VerifiedComponent](args, "components")
		if err != nil {
			return nil, err
		}
		result, err := manager.Commit(CommitRequest{TransactionID: transactionID, ExpectedRevision: expected, Components: components, Home: deps.Home})
		if err == nil && deps.Changed != nil {
			deps.Changed(environment.ChangeEvent, result)
		}
		return result, err
	}})
	registry.MustRegister(control.Command{Name: "artifact_install_rollback", Handler: func(args control.Args) (any, error) {
		transactionID, err := control.Arg[string](args, "transactionId")
		if err != nil {
			return nil, err
		}
		return nil, manager.Rollback(transactionID)
	}})
}
