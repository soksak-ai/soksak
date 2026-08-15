package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Korean stays in the resource bundles and nowhere else (AGENTS 6-1).
//
// This repository is read in English by whoever opens it, history included. The
// prose gate reads .go, .ts and .tsx; measured 2026-08-15, that left 493 Korean
// comment lines in App.css and 1,034 in the Korean editions of the documents
// outside every rule, because no gate had ever opened those files.
//
// The exempt files are named, not pattern-matched. A bundle is a file whose
// whole purpose is to hold one language, and there are few of them; a pattern
// would quietly exempt the next file that happened to match it.
var koreanBundles = map[string]bool{
	"frontend/src/i18n.ko.ts": true,
}

// koreanIsData is a file where Hangul is the subject, not prose about it: an IME
// sequence, a multibyte boundary fixture, the measured tofu example. Removing it
// would destroy what the file proves. Each entry states why.
var koreanIsData = map[string]string{
	"frontend/src/App.css":    "the measured tofu example — 터미널(고스티), 고, 스",
	"frontend/index.html":     "the boot screen's ko/en pair, inline because the key table is not loaded yet",
	"frontend/src/i18n.ts":    "the language tag table",
	"frontend/src/i18n.en.ts": "keys are shared with the ko table",
}

// koreanScanned is every extension a reader of this repository opens.
var koreanScanned = map[string]bool{
	".go": true, ".ts": true, ".tsx": true, ".css": true, ".md": true,
	".html": true, ".json": true, ".mjs": true, ".js": true,
}

// koreanDebt is how many Hangul lines remain outside the two named bundles.
//
// Measured 2026-08-15 and every one of them accounted for: 245 are the KO values
// of the per-package messages.go tables, which are the Go side of the bundle;
// 227 are the ko trigger words composeTriggers matches an utterance against; 50
// are test fixtures — a multibyte boundary, an IME sequence; 9 are the banned
// vocabulary list in AGENTS.md, which is the rule's own data; 5 are the measured
// tofu example and the boot screen's pair.
//
// It is a ratchet: the number may only go down. Anything that raises it is a new
// sentence in the wrong place. If it falls, lower this and say which category
// shrank — a floor nobody can explain is not a floor.
const koreanDebt = 531

func TestKoreanStaysInTheBundles(t *testing.T) {
	type finding struct {
		path  string
		lines int
	}
	var found []finding
	total := 0
	scanned := 0

	err := filepath.Walk(".", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if skippedTrees[info.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if !koreanScanned[filepath.Ext(path)] {
			return nil
		}
		clean := filepath.ToSlash(path)
		if koreanBundles[clean] {
			return nil
		}
		if _, isData := koreanIsData[clean]; isData {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		scanned++
		lines := 0
		for _, line := range strings.Split(string(body), "\n") {
			if hasHangul(line) {
				lines++
			}
		}
		if lines > 0 {
			found = append(found, finding{clean, lines})
			total += lines
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scanning the tree: %v", err)
	}
	if scanned == 0 {
		t.Fatal("no files were scanned; the extensions are wrong")
	}

	if total > koreanDebt {
		var worst []string
		for _, f := range found {
			worst = append(worst, f.path+": "+itoa(f.lines))
		}
		t.Errorf("Hangul outside the bundles went from %d to %d lines in %d files:\n%s\n"+
			"Write it in English, or move the sentence into the bundle.",
			koreanDebt, total, len(found), strings.Join(worst, "\n"))
	}
	if total < koreanDebt {
		t.Errorf("Hangul outside the bundles is down to %d from %d.\n"+
			"Lower koreanDebt to %d so the ratchet holds the new floor.", total, koreanDebt, total)
	}
}
