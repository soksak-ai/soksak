package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The core does not know what "back" means (C1, A1).
//
// A content view navigates, names itself, and loads or stops — those are facts
// about any view a pane can hold, and the core relays them so a tab can show a
// title. Whether a *second* step backwards exists is a browser's history, and
// the plugin that owns the history is the only thing that can answer it.
//
// Measured 2026-08-16: frameworks/wails/surface_pages.go read canBack and
// canForward off a plugin's page report and decided which event carried them,
// and frontend/src/lib/contentViewEvents.ts called canGoBack on an element.
// Neither is a plugin name, so the coupling gate saw nothing. The core held a
// browser feature and every gate passed.
//
// Comments are stripped first. The payload contract has to be writable down —
// a doc comment naming the fields a plugin sends is the contract, not a use of
// them. Code is where the core would act on one.
var historyWords = regexp.MustCompile(
	`canBack|canForward|canGoBack|canGoForward|estimatedProgress|` +
		`did-navigate|did-start-loading|did-stop-loading|page-title-updated|` +
		`update-target-url|getWebContentsId`)

// Line and block comments, in the three languages scanned. A string literal is
// left in place on purpose: a core with "did-navigate" as a value has
// wired itself to an engine's vocabulary, which is the thing forbidden here.
var (
	lineComment  = regexp.MustCompile(`(?m)^\s*(//|\*|/\*).*$`)
	blockComment = regexp.MustCompile(`(?s)/\*.*?\*/`)
)

func withoutComments(source string) string {
	return lineComment.ReplaceAllString(blockComment.ReplaceAllString(source, ""), "")
}

func TestTheCoreDoesNotKnowWhatBackMeans(t *testing.T) {
	var found []string
	scanned := 0

	paths, err := trackedRecordFilesUnder(".", scannedCode, []string{"frontend/src/", "core/", "frameworks/"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		clean := filepath.ToSlash(path)
		// A test states the contract by exercising it, so it may name the
		// fields a plugin sends.
		if strings.Contains(clean, ".test.") || strings.HasSuffix(clean, "_test.go") {
			continue
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatal(readErr)
		}
		scanned++
		for index, line := range strings.Split(withoutComments(string(body)), "\n") {
			if word := historyWords.FindString(line); word != "" {
				found = append(found, clean+":"+itoa(index+1)+" "+word)
			}
		}
	}
	if scanned == 0 {
		t.Fatal("no core source was scanned; the roots are wrong")
	}
	if len(found) > 0 {
		t.Errorf("the core acts on a browser's history in %d places:\n%s\n"+
			"A view navigates and loads; a history belongs to the plugin that keeps one.",
			len(found), strings.Join(found, "\n"))
	}
}

// The core writes down no surface kind (C1).
//
// A surface label is `<kind>.<window>.<view>` (NAMING N3). The window field is the core's — it is what makes
// the value unique across windows — and the kind is the word of whoever declared the surface. A
// core holding one can only find the surfaces of the plugin it was written against, and a second
// kind of surface gets a label from nowhere.
//
// Measured 2026-08-16: the core held `brw-`, minted a browser's identifier and handed it back
// through `app.webview.label(viewId)`. The plugin asked the core what it was called.
//
// Comments are stripped: the measurement above has to be writable down next to the rule.
var surfaceKindWords = regexp.MustCompile(`\bbrw\b|"brw-|'brw-|` + "`brw-")

func TestTheCoreWritesDownNoSurfaceKind(t *testing.T) {
	var found []string
	scanned := 0

	paths, err := trackedRecordFilesUnder(".", scannedCode, []string{"frontend/src/", "core/", "frameworks/"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		clean := filepath.ToSlash(path)
		// A test may write a kind: it is standing in for a plugin, and a fixture whose label
		// had no kind would not be a label any plugin produces.
		if strings.Contains(clean, ".test.") || strings.HasSuffix(clean, "_test.go") {
			continue
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatal(readErr)
		}
		scanned++
		for index, line := range strings.Split(withoutComments(string(body)), "\n") {
			if word := surfaceKindWords.FindString(line); word != "" {
				found = append(found, clean+":"+itoa(index+1)+" "+word)
			}
		}
	}
	if scanned == 0 {
		t.Fatal("no core source was scanned; the roots are wrong")
	}
	if len(found) > 0 {
		t.Errorf("the core writes down a surface kind in %d places:\n%s\n"+
			"The shape is the core's and the kind is the declarer's. Take the kind from the caller, "+
			"or read the label off the declaration (lib/surfaceLabels.ts).",
			len(found), strings.Join(found, "\n"))
	}
}
