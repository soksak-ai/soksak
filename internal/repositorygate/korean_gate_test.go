package repositorygate

import (
	"os"
	"path/filepath"
	"regexp"
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

	// The Go side of the same bundle. A messages.go holds one package's sentence
	// table and nothing else — an EN and a KO string per key — so its Hangul is
	// the resource, not prose that leaked into code. Named one by one for the
	// reason above: a */messages.go pattern would exempt the next file that took
	// the name for something else.
	"cmd/sok/messages.go":              true,
	"core/boot/messages.go":            true,
	"core/control/messages.go":         true,
	"core/daemon/messages.go":          true,
	"core/files/messages.go":           true,
	"core/identity/messages.go":        true,
	"core/install/messages.go":         true,
	"core/net/messages.go":             true,
	"core/process/messages.go":         true,
	"core/registrytrust/messages.go":   true,
	"core/secret/messages.go":          true,
	"core/session/messages.go":         true,
	"core/environment/messages.go":     true,
	"core/service/messages.go":         true,
	"core/sidecar/messages.go":         true,
	"core/store/messages.go":           true,
	"core/workspace/messages.go":       true,
	"frameworks/wails/messages.go":     true,
	"cmd/package-release/messages.go":  true,
	"internal/application/messages.go": true,
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

// koreanTrigger matches the one line where a Korean word is required by the
// mechanism rather than tolerated by it: the ko field of a command's triggers,
// which composeTriggers merges into the string an utterance is matched against.
// A command with no Korean triggers cannot be found by a Korean utterance, so
// every command a person can reach adds one of these lines.
//
// It is matched by line, not by file, because these lines sit inside catalog
// files that are otherwise English. The pattern is the field, not the Hangul —
// a Korean sentence anywhere else on the line is still counted.
var koreanTrigger = regexp.MustCompile(`(^|\{)\s*ko:\s*"`)

// koreanReading matches an assertion about the content of a sentence's Korean
// edition. Checking that a promise is in both editions means naming a fragment of
// the Korean one — a half-translated sentence is the defect a key exists to
// prevent, and no test can hold that without a Korean word in it.
//
// The reader scope is what is matched, not the Hangul: a Korean sentence
// elsewhere on the line is still counted.
var koreanReading = regexp.MustCompile(`withReaderLanguage\(\s*"ko"`)

// koreanDebt is how many Hangul lines remain that no rule accounts for.
//
// The count used to fold three different things together — the bundles, the
// trigger vocabulary, and stray Korean — into one number of 531. That number
// could not do its job in either direction: it rose whenever a command was
// added, which is correct work, and it could not say whether a fall came from
// deleting a Korean comment or from deleting a command.
//
// So the two accounted categories were named above and this counts what is
// left. Measured 2026-08-16 it is 43 lines: 32 in test fixtures, where the
// Hangul is the subject of the test — a multibyte boundary, an IME sequence, a
// CJK trigram search term that stops proving anything the moment it is written
// in English; 7 lines of banned vocabulary in AGENTS.md, which is the rule's
// own data; 3 in the gates themselves, which have to name what they look for;
// and 1 IME example in a command's examples list.
//
// It is a ratchet: the number may only go down. Anything that raises it is a
// new sentence in the wrong place. If it falls, lower this and say which
// category shrank — a floor nobody can explain is not a floor.
//
// 2026-08-26: 41 to 44. The three lines are the prose gate's own banned-word
// table, which grew when the register rules did. That table is a list of what
// the gate looks for, not prose, and it is the one category this floor already
// exempts.
//
// 2026-08-26: 44 to 43. Same table, packed onto fewer lines when it grew again.
//
// 2026-08-26: 43 to 38. AGENTS.md 6-3 stopped restating the banned-word table and
// points at the gate that holds it, which removed five lines of Hangul that were
// a copy of the rule's own data.
const koreanDebt = 39

func TestKoreanStaysInTheBundles(t *testing.T) {
	type finding struct {
		path  string
		lines int
	}
	var found []finding
	total := 0
	scanned := 0

	paths, err := trackedRecordFiles(".", koreanScanned, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		clean := filepath.ToSlash(path)
		if strings.HasSuffix(clean, ".ko.md") {
			canonical := strings.TrimSuffix(clean, ".ko.md") + ".md"
			if _, err := os.Stat(canonical); err != nil {
				t.Errorf("Korean translation has no English canonical document: %s", clean)
			}
			continue
		}
		if koreanBundles[clean] {
			continue
		}
		if _, isData := koreanIsData[clean]; isData {
			continue
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatal(readErr)
		}
		scanned++
		lines := 0
		for _, line := range strings.Split(string(body), "\n") {
			if hasHangul(line) && !koreanTrigger.MatchString(line) && !koreanReading.MatchString(line) {
				lines++
			}
		}
		if lines > 0 {
			found = append(found, finding{clean, lines})
			total += lines
		}
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
