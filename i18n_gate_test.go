package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// A sentence a person reads comes from a key, and this holds that after the fact
// is true rather than while it is being made true.
//
// The sweep that emptied this surface proves nothing about the next commit. A
// hardcoded label reads correctly in the default language, so nobody sees it
// until the product runs in another one and a screen comes back half
// translated. That is what this refuses.
//
// It reads the surfaces where the reader is not in question: a rendered
// attribute, and the description a command palette and `sok` help both show.
// Everything subtler — a refusal that may or may not travel to a caller — is a
// judgement this cannot make, and it does not pretend to.
var (
	renderedAttribute = regexp.MustCompile(`\b(?:title|placeholder|aria-label|alt)\s*=\s*"([^"]{4,})"`)
	shownField        = regexp.MustCompile(`^\s*(?:description|title|label|hint|detail|caution|summary|placeholder)\s*:\s*"([^"]{5,})"`)
	throughAKey       = regexp.MustCompile(`\bt(?:msg)?\s*\(|\blocalize\s*\(`)
)

// prose is a value a person would read as a sentence rather than as a name: two
// or more words, at least two of them letters. A class, a path, an event name
// and a URL are not sentences and are not this gate's business.
func prose(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) < 5 || !strings.Contains(value, " ") {
		return false
	}
	for _, start := range []string{"http://", "https://", "/", "./", "data:", "#", "--"} {
		if strings.HasPrefix(value, start) {
			return false
		}
	}
	return len(regexp.MustCompile(`[A-Za-z\p{Hangul}]{2,}`).FindAllString(value, -1)) >= 2
}

func TestAShownSentenceComesFromAKey(t *testing.T) {
	var found []string
	scanned := 0

	err := filepath.Walk(filepath.Join("frontend", "src"), func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.IsDir() {
			if skippedTrees[info.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		extension := filepath.Ext(path)
		if extension != ".ts" && extension != ".tsx" {
			return nil
		}
		clean := filepath.ToSlash(path)
		// A test's fixture is read by nobody, and the bundles are where the
		// sentences live.
		if strings.Contains(clean, ".test.") ||
			strings.HasSuffix(clean, "i18n.ko.ts") || strings.HasSuffix(clean, "i18n.en.ts") {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		scanned++
		for index, line := range strings.Split(string(body), "\n") {
			trimmed := strings.TrimSpace(line)
			if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "*") ||
				strings.HasPrefix(trimmed, "/*") || throughAKey.MatchString(line) {
				continue
			}
			for _, pattern := range []*regexp.Regexp{renderedAttribute, shownField} {
				match := pattern.FindStringSubmatch(line)
				if match == nil || !prose(match[1]) {
					continue
				}
				found = append(found, clean+":"+itoa(index+1)+" "+match[1])
				break
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scanning the frontend: %v", err)
	}
	if scanned == 0 {
		t.Fatal("no frontend source was scanned; the path is wrong")
	}

	if len(found) > 0 {
		t.Errorf("these sentences are shown to a person without a key, in %d places:\n%s\n"+
			"Add the key to i18n.ko.ts and i18n.en.ts and read it with t() or tmsg().",
			len(found), strings.Join(found, "\n"))
	}
}
