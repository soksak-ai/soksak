package repositorygate

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Two rules about how this repository puts state on disk.
//
// Both are here rather than in a review note because both were broken in ways nothing reported: a
// reader read 0 bytes of a value being written, and it took a concurrency probe to see it.

// A durable write publishes in one step.
//
// os.WriteFile truncates the target and then writes it. A reader arriving between the two sees a
// file that is neither the old contents nor the new ones, and a write that dies part-way leaves
// that on disk permanently. core/atomicfile publishes by renaming a neighbour over the target,
// which is one step.
//
// Measured 2026-09-03: four writers held the broken shape — a plugin's stored values, the install
// commit journal that recovery reads after a crash, a sidecar's adoption record, and the person's
// own file save.
//
// Exemptions are named one by one with the reason, never by pattern: a pattern exempts the next
// file that takes the name for something else.
var durableWriteExempt = map[string]string{
	// The staged half of a publish. These write a neighbour and rename it themselves, which is the
	// rule rather than an exception to it — they predate the shared helper.
	"core/install/theme.go":     "writes a staging file and renames it",
	"core/environment/store.go": "writes a staging file and renames it",
	"core/service/ledger.go":    "writes a staging file and renames it",
	// A release is built once into an empty output directory and nothing reads it while it is being
	// built. There is no reader to see a partial file.
	"cmd/package-release/archive.go": "builds a release into a fresh directory, with no concurrent reader",
	"cmd/package-release/main.go":    "builds a release into a fresh directory, with no concurrent reader",
	// The helper the rule points at.
	"core/atomicfile/publish.go": "is the publish",
}

var plainFileWrite = regexp.MustCompile(`\bos\.WriteFile\(`)

func TestADurableWriteIsPublishedInOneStep(t *testing.T) {
	paths, err := trackedRecordFiles(".", map[string]bool{".go": true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var offenders []string
	for _, path := range paths {
		clean := filepath.ToSlash(path)
		if strings.HasSuffix(clean, "_test.go") || durableWriteExempt[clean] != "" {
			continue
		}
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if plainFileWrite.Match(body) {
			offenders = append(offenders, clean)
		}
	}
	if len(offenders) > 0 {
		t.Errorf("these write a file in two steps, so a reader can see neither version:\n%s\n"+
			"Publish it with core/atomicfile.Publish, or name it in durableWriteExempt with the "+
			"reason no reader can arrive mid-write.", strings.Join(offenders, "\n"))
	}
	for path := range durableWriteExempt {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("durableWriteExempt names %s, which is not here", path)
		}
	}
}

// This repository makes no symbolic links.
//
// A link is a second name for a path, and which of the two a reader gets depends on how it arrived
// rather than on anything declared. Paths are resolved from what is declared — a manifest, an
// environment entry, a configured root — so that the answer does not depend on the route.
//
// Reading one is a different matter and stays allowed: a person's own disk holds links this
// repository did not make, and a save through one writes what it points at rather than replacing it.
var makesLink = regexp.MustCompile(`\bos\.Symlink\(`)

func TestThisRepositoryMakesNoSymbolicLinks(t *testing.T) {
	paths, err := trackedRecordFiles(".", map[string]bool{".go": true}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var offenders []string
	for _, path := range paths {
		clean := filepath.ToSlash(path)
		if strings.HasSuffix(clean, "_test.go") {
			// A fixture makes one to measure what happens to a link this repository did not make.
			continue
		}
		body, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if makesLink.Match(body) {
			offenders = append(offenders, clean)
		}
	}
	if len(offenders) > 0 {
		t.Errorf("these make a symbolic link:\n%s\nResolve the path from what is declared instead.",
			strings.Join(offenders, "\n"))
	}
}
