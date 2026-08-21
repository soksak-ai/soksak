package main

import (
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/soksak-ai/soksak-core/core/contentview"
)

// The page and the core agree on what a content view event is called.
//
// TypeScript cannot read a Go constant, so the page keeps a copy. A copy that
// drifts does not fail: the host emits one name, the page listens for another,
// and the event arrives nowhere. Nothing raises, nothing logs, and the symptom
// is a control that never becomes enabled — measured 2026-08-01 in the
// preceding implementation, where a permanently disabled back button was the
// only trace of a snake_case name meeting a camelCase listener.
func TestTheCoreAndThePageNameTheSameEvents(t *testing.T) {
	source, err := os.ReadFile("frontend/src/lib/contentViewEvents.ts")
	if err != nil {
		t.Fatalf("reading the page's table: %v", err)
	}
	table := regexp.MustCompile(`(?s)export const CONTENT_VIEW_EVENT = \{(.*?)\n\} as const;`).FindStringSubmatch(string(source))
	if table == nil {
		t.Fatal("the page's CONTENT_VIEW_EVENT table is not where this gate looks for it")
	}

	page := map[string]string{}
	for _, entry := range regexp.MustCompile(`(\w+):\s*"([^"]+)"`).FindAllStringSubmatch(table[1], -1) {
		page[entry[1]] = entry[2]
	}

	core := map[string]string{
		"nav":             contentview.Navigated,
		"title":           contentview.Title,
		"loading":         contentview.Loading,
		"status":          contentview.Status,
		"openExternal":    contentview.OpenExternal,
		"activated":       contentview.Activated,
		"openExternalRaw": contentview.OpenExternalRaw,
	}

	var wrong []string
	for key, want := range core {
		got, present := page[key]
		if !present {
			wrong = append(wrong, key+": the page has no entry")
			continue
		}
		if got != want {
			wrong = append(wrong, key+": the page says "+got+", the core says "+want)
		}
	}
	for key := range page {
		if _, present := core[key]; !present {
			wrong = append(wrong, key+": the page has an entry the core does not name")
		}
	}
	if len(wrong) > 0 {
		t.Errorf("the two tables disagree in %d places:\n%s\n"+
			"Change core/contentview/events.go and the page's copy together.",
			len(wrong), strings.Join(wrong, "\n"))
	}
}
