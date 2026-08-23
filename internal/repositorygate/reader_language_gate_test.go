package repositorygate

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// A refusal from a window is a key, not a finished sentence.
//
// A handler runs before the reader of the answer is known: the same refusal goes to a window, to a
// sok caller and to a log line. Rendering it in the handler picks a language before the caller is
// in hand — measured 2026-08-16, an English sok call was answered TARGET_NOT_FOUND with its
// sentence in Korean, because the window rendered its own display language and nothing had told it
// otherwise.
//
// The Go side already keeps this rule (i18n.Errorf builds a key, control.Answer renders at the
// edge). This holds the page to the same one: notFound takes a key, and the registry renders it
// where the caller's language has been stamped onto the call.
var refusalRendersEarly = regexp.MustCompile(`notFound\(\s*(tmsg|t)\(`)

func TestARefusalFromAWindowHoldsItsKey(t *testing.T) {
	var early []string

	paths, err := trackedRecordFilesUnder(".", map[string]bool{".ts": true, ".tsx": true}, []string{"frontend/src/"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range paths {
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatal(readErr)
		}
		for index, line := range strings.Split(string(body), "\n") {
			if refusalRendersEarly.MatchString(line) {
				early = append(early, filepath.ToSlash(path)+":"+itoa(index+1))
			}
		}
	}

	if len(early) > 0 {
		t.Errorf("a refusal is rendered before the reader is known in %d places:\n%s\n"+
			"Pass the key: notFound(\"key\", params). The registry renders it at the edge.",
			len(early), strings.Join(early, "\n"))
	}
}
