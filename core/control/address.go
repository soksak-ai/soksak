package control

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/soksak/soksak-core/core/i18n"
)

// Where this installation answers from.
//
// Both answers are values the launcher already holds. Neither is discovered
// here, and neither is guessed: the frontend spawns an agent that must reach
// *this* backend, and an agent pointed at a neighbouring installation's socket
// does not fail — it succeeds against the wrong application.

func registerAddress(registry *Registry, deps Deps) {
	if deps.Socket == "" {
		refuse(registry, commandSocketPath,
			"this process was not told which socket its control plane listens on")
	} else {
		registry.MustRegister(Command{
			Name:  commandSocketPath,
			Owner: OwnerCore,
			Handler: func(Args) (any, error) {
				return deps.Socket, nil
			},
		})
	}

	switch {
	case deps.CLIDir == "":
		refuse(registry, commandCLIDir,
			"this process was not told which directory holds its client binary")
	case deps.CLIName == "":
		refuse(registry, commandCLIDir,
			"this process was not told what its client binary is called")
	default:
		registry.MustRegister(Command{
			Name:  commandCLIDir,
			Owner: OwnerCore,
			Handler: func(Args) (any, error) {
				return clientDirectory(deps.CLIDir, deps.CLIName)
			},
		})
	}
}

// clientDirectory answers where the client binary is, having looked.
//
// The check is here rather than left to the caller because the caller is a
// spawn: the frontend joins this directory to the client's name and runs it,
// and a directory that does not hold the binary comes back as the agent's own
// startup failure several layers away from the wrong answer that caused it.
//
// It is asked per call rather than once at registration. A checkout builds the
// client after the application is already running, and an answer cached at boot
// would keep refusing a binary that is now there.
func clientDirectory(directory, name string) (string, error) {
	binary := filepath.Join(directory, name)
	info, err := os.Stat(binary)
	if err != nil {
		return "", fmt.Errorf("the %s client is not at %s: %w", name, binary, err)
	}
	if info.IsDir() {
		return "", i18n.Errorf("control.address.clientIsDirectory", map[string]string{"path": binary, "name": name})
	}
	return directory, nil
}
