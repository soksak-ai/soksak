package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// A plugin's shipped bundle is not older than the source it was built from.
//
// Every gate here installs `main.js` and runs that. The source beside it is what a person edits and
// what the plugin's own unit tests import, so the two are read by different readers and nothing
// compared them: measured 2026-08-18, both plugins' command descriptions were moved to language
// maps, their unit tests passed, six full suites passed, and neither bundle held a word of it. The
// change was in the repository and not in the product, and every reading said it was fine.
//
// Time, not content. What the bundler emits is minified, escaped and rearranged — a sentence
// outside ASCII arrives as a run of \uXXXX escapes — so searching the bundle for the source's own
// text is a second implementation of the bundler, and it would be wrong on its own terms. When each
// file was written is a fact neither side can disagree about.

// pluginRoots are the directories a gate installs from, the same ones `task install:plugins` copies.
func pluginRoots(t *testing.T) []string {
	t.Helper()
	found, err := filepath.Glob(filepath.Join("..", "soksak-plugins", "*"))
	if err != nil {
		t.Fatalf("looking for the plugins: %v", err)
	}
	var roots []string
	for _, root := range found {
		if _, err := os.Stat(filepath.Join(root, "plugin.json")); err == nil {
			roots = append(roots, root)
		}
	}
	if len(roots) == 0 {
		t.Skip("no sibling plugin is checked out beside this repository")
	}
	return roots
}

// newestSourceUnder is the most recent write under a directory, skipping what is not source.
func newestSourceUnder(t *testing.T, root string) (string, time.Time) {
	t.Helper()
	newest := time.Time{}
	where := ""
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		if info.IsDir() {
			// node_modules is the dependency tree and dist is another build's output; neither is
			// what this plugin's bundle is built from.
			if skippedTrees[info.Name()] || info.Name() == "node_modules" || info.Name() == "dist" {
				return filepath.SkipDir
			}
			return nil
		}
		switch filepath.Ext(path) {
		case ".ts", ".tsx", ".css":
			// A test is source a bundle never holds. Editing one does not make the bundle stale.
			if strings.Contains(filepath.ToSlash(path), ".test.") {
				return nil
			}
			if info.ModTime().After(newest) {
				newest = info.ModTime()
				where = path
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walking %s: %v", root, err)
	}
	return where, newest
}

func TestAShippedBundleIsNotOlderThanItsSource(t *testing.T) {
	for _, root := range pluginRoots(t) {
		bundle := filepath.Join(root, "main.js")
		built, err := os.Stat(bundle)
		if err != nil {
			// A plugin with no bundle ships nothing to be stale. The manifest names its entry, and
			// a manifest naming one that is not there is a different rule than this.
			continue
		}
		source, edited := newestSourceUnder(t, filepath.Join(root, "frontend"))
		if source == "" {
			continue
		}
		if edited.After(built.ModTime()) {
			t.Errorf("%s ships a bundle built %s and its newest source %s was edited %s.\n"+
				"Every gate installs the bundle and runs that, so what was changed here is in the "+
				"repository and not in the product. Build it: cd %s/frontend && npm run build.",
				filepath.Base(root),
				built.ModTime().Format(time.RFC3339),
				filepath.Base(source),
				edited.Format(time.RFC3339),
				root)
		}
	}
}
