// Package repositoryroot discovers the current checkout from its Go module marker.
package repositoryroot

import (
	"fmt"
	"os"
	"path/filepath"
)

func Discover(start string) (string, error) {
	directory, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		marker := filepath.Join(directory, "go.mod")
		if info, statErr := os.Stat(marker); statErr == nil && !info.IsDir() {
			return directory, nil
		}
		parent := filepath.Dir(directory)
		if parent == directory {
			return "", fmt.Errorf("repository root not found above %s", start)
		}
		directory = parent
	}
}
