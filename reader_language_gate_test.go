package main

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

	err := filepath.Walk("frontend/src", func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if skippedTrees[info.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		ext := filepath.Ext(path)
		if ext != ".ts" && ext != ".tsx" {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		for index, line := range strings.Split(string(body), "\n") {
			if refusalRendersEarly.MatchString(line) {
				early = append(early, filepath.ToSlash(path)+":"+itoa(index+1))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scanning the page: %v", err)
	}

	if len(early) > 0 {
		t.Errorf("a refusal is rendered before the reader is known in %d places:\n%s\n"+
			"Pass the key: notFound(\"key\", params). The registry renders it at the edge.",
			len(early), strings.Join(early, "\n"))
	}
}
