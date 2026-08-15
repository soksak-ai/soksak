package main

import (
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

// An English sentence that counts something declares both of its forms.
//
// Measured 2026-08-16: an English caller asking for one pane was answered "1 panes". I5 forbids
// choosing in the caller — `n === 1 ? … : …` is right for English, wrong for Korean, which has one
// form, and wrong in a different way for Russian and Arabic. So the forms are in the table and Intl
// picks one.
//
// Korean has one form, so a Korean value with branches holds one nothing will ever select.

var (
	tableEntry  = regexp.MustCompile(`(?m)^\s*"([^"]+)":\s*"((?:[^"\\]|\\.)*)",?\s*$`)
	countsThing = regexp.MustCompile(`\{n\}|\{count\}`)
	// ICU, because a bare separator is not safe here: the table already writes prose containing a
	// pipe ("flow | pin", "stroke|fill|both"), and a separator that appears in sentences turns one
	// of those into a form nothing selects.
	icuPlural = regexp.MustCompile(`^\{\s*\w+\s*,\s*plural\s*,`)
)

// pluralExempt is a counted sentence whose number is not counting nouns. Each states why.
var pluralExempt = map[string]string{
	"space.autoTitle":          "the number names the space, the way a title does",
	"msg.layout.arrangement":   "the number is which line the rail stands on",
	"msg.layout.verify":        "px does not inflect",
	"msg.layout.verify.moving": "px does not inflect",
}

func TestACountedEnglishSentenceDeclaresBothForms(t *testing.T) {
	english := readTable(t, "frontend/src/i18n.en.ts")
	var single []string
	for key, value := range english {
		if !countsThing.MatchString(value) || icuPlural.MatchString(value) {
			continue
		}
		if _, allowed := pluralExempt[key]; allowed {
			continue
		}
		single = append(single, key+" = "+value)
	}
	if len(single) > 0 {
		sort.Strings(single)
		t.Errorf("%d English sentences count something and declare one form:\n%s\n"+
			"Write both: \"{n, plural, one {# pane} other {# panes}}\". "+
			"If the number is not counting nouns, name the key in pluralExempt with the reason.",
			len(single), strings.Join(single, "\n"))
	}
}

func TestAKoreanSentenceNeedsNoForms(t *testing.T) {
	// Korean has one plural category, so a Korean sentence is written plainly. A branch there is
	// either the only one — which the plain sentence already is — or one nothing selects.
	korean := readTable(t, "frontend/src/i18n.ko.ts")
	var branched []string
	for key, value := range korean {
		if icuPlural.MatchString(value) {
			branched = append(branched, key+" = "+value)
		}
	}
	if len(branched) > 0 {
		sort.Strings(branched)
		t.Errorf("%d Korean sentences declare plural branches:\n%s\n"+
			"Korean has one plural category — write the sentence plainly.",
			len(branched), strings.Join(branched, "\n"))
	}
}

func TestTheTwoTablesAgreeOnWhatCounts(t *testing.T) {
	// A key counted in one language and not the other is a sentence that reads as a count on one
	// screen and as a statement on the other.
	english := readTable(t, "frontend/src/i18n.en.ts")
	korean := readTable(t, "frontend/src/i18n.ko.ts")
	var disagreed []string
	for key, value := range english {
		other, present := korean[key]
		if !present {
			continue
		}
		// An ICU plural writes its number as # inside the branches, so the English side of a counted
		// key matches on the notation rather than on the placeholder.
		counts := countsThing.MatchString(value) || icuPlural.MatchString(value)
		if counts != countsThing.MatchString(other) {
			disagreed = append(disagreed, key)
		}
	}
	if len(disagreed) > 0 {
		sort.Strings(disagreed)
		t.Errorf("%d keys count something in one language and not the other:\n%s",
			len(disagreed), strings.Join(disagreed, "\n"))
	}
}

func readTable(t *testing.T, path string) map[string]string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	table := map[string]string{}
	for _, match := range tableEntry.FindAllStringSubmatch(string(body), -1) {
		table[match[1]] = match[2]
	}
	if len(table) == 0 {
		t.Fatalf("%s holds no entries this gate can read", path)
	}
	return table
}
