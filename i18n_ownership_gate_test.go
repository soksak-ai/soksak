package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A message is owned by whatever it is about.
//
// The core's sentences are in the core, a unit's in the unit, and nothing outside this repository
// declares into this repository's registry. It is one registry per owner rather than one for
// everything, and the reason is not tidiness.
//
// A unit that declared into an application's registry could only ever be used by that application:
// its sentences would be missing everywhere else, and what a person would see is a refusal with no
// words in it. It also makes the wording the application's while the fact is the unit's, so the two
// part the day the application rewords something the unit meant precisely.
//
// A unit states the fact — which target, which operation, what was missing. Whoever embeds it words
// that for a person if it wants to. Measured 2026-08-20: a host service declared one sentence into
// this registry, which was the whole of its dependency on this application.
//
// Read from the sibling trees rather than from this one, because what is refused is the direction:
// this repository importing its own registry is what the registry is for.
func TestNoSiblingDeclaresIntoThisRegistry(t *testing.T) {
	roots := []string{
		filepath.Join("..", "wails-services"),
		filepath.Join("..", "soksak-sidecars"),
		filepath.Join("..", "soksak-plugins"),
		filepath.Join("..", "soksak-contracts"),
		filepath.Join("..", "soksak-kits"),
	}

	var found []string
	for _, root := range roots {
		if _, err := os.Stat(root); err != nil {
			continue
		}
		err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return err
			}
			if info.IsDir() {
				switch info.Name() {
				case "node_modules", "target", "dist", ".git":
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(path, ".go") {
				return nil
			}
			body, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			if strings.Contains(string(body), "soksak-core/core/i18n") {
				found = append(found, path)
			}
			return nil
		})
		if err != nil {
			t.Fatalf("reading %s: %v", root, err)
		}
	}

	if len(found) != 0 {
		t.Fatalf("these units declare into this application's message registry:\n  %s\n"+
			"A unit's sentences are the unit's. Importing this registry makes the unit unusable "+
			"outside this application — its sentences are missing everywhere else, and a person sees "+
			"a refusal with no words in it.\n"+
			"State the fact in the unit's own error, and let whoever embeds it do the wording.",
			strings.Join(found, "\n  "))
	}
}
