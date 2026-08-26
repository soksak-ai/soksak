package repositorygate

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Prose in this repository is dry, short and exact. The words below are a
// different register — they give code intentions and senses it does not have.
// They were corrected four times on 2026-08-15 before this gate existed, and
// 392 comment lines were rewritten to clear it.
//
// Two lists because the two languages fail differently. Korean prose puts the
// personification in the verb; English uses a small set of verbs of perception
// and speech.
//
// The lists are examples, not the rule. The rule is: does this sentence state a
// fact, or set a mood? A gate cannot ask that, so it catches the words that
// were actually used.
var bannedKorean = []string{
	"산다", "말한다", "돈다", "센다", "싣는다", "싣고", "흘린다", "흘려보낸",
	"꽂으면", "달고", "가리킨다", "밝힌다", "고아", "물어야", "1급",
}

// English words are matched on a word boundary. Without it a longer word that
// ends in a banned one fails, and a plural noun spelled like a banned verb
// fails too.
var bannedEnglish = regexp.MustCompile(
	`\b(lives|sits|says|tells|knows|asks|reaches|carries|belongs|learns|decides|reflects)\b`)

// scannedCode is every extension whose comments this repository authors.
var scannedCode = map[string]bool{
	".go": true, ".ts": true, ".tsx": true,
}

func TestDocumentsAreWrittenDry(t *testing.T) {
	roots := []string{
		filepath.Join("docs", "tech"),
		filepath.Join("docs", "manual"),
	}

	var found []string
	scanned := 0
	for _, root := range roots {
		err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				if os.IsNotExist(err) {
					return filepath.SkipDir
				}
				return err
			}
			if info.IsDir() || !strings.HasSuffix(path, ".md") {
				return nil
			}
			body, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			scanned++
			for index, line := range strings.Split(string(body), "\n") {
				for _, word := range bannedKorean {
					if strings.Contains(line, word) {
						found = append(found, path+":"+itoa(index+1)+" "+word)
					}
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("scanning %s: %v", root, err)
		}
	}

	if scanned == 0 {
		t.Fatal("no documents were scanned; the roots are wrong")
	}
	if len(found) > 0 {
		t.Errorf("these lines use the banned register in %d places:\n%s\n"+
			"State the fact and the next action instead.", len(found), strings.Join(found, "\n"))
	}
}

// TestCommentsAreWrittenDry holds the same standard over code.
//
// It was excluded when this gate was written, on the grounds that the sweep was
// separate work. That exclusion is what let the register spread: a rule nothing
// enforces is a preference. The sweep is done, so the exclusion goes.
func TestCommentsAreWrittenDry(t *testing.T) {
	var found []string
	var korean []string
	files, err := trackedRecordFiles(".", scannedCode, []string{"frontend/bindings/"})
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range files {
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatal(readErr)
		}
		byLine := commentText(string(body))
		for _, number := range sortedLines(byLine) {
			text := byLine[number]
			if word := bannedEnglish.FindString(text); word != "" {
				found = append(found, path+":"+itoa(number)+" "+word)
			}
			for _, word := range bannedKorean {
				if strings.Contains(text, word) {
					korean = append(korean, path+":"+itoa(number)+" "+word)
				}
			}
		}
	}

	if len(files) == 0 {
		t.Fatal("no source files were scanned; the extensions are wrong")
	}
	if len(found) > 0 {
		t.Errorf("these comments use the banned register in %d places:\n%s\n"+
			"State what a thing is, what is missing, and what to do about it.",
			len(found), strings.Join(found, "\n"))
	}
	if len(korean) > 0 {
		t.Errorf("these Korean comments use the banned register in %d places:\n%s\n"+
			"State the fact. The verb is what carries the register here.",
			len(korean), strings.Join(korean, "\n"))
	}
}

// TestBundleValuesAreWrittenDry holds the register over the one place Korean
// remains.
//
// The comment gate reads comments, and the document gate reads documents. With
// the Korean editions of the documents gone (6-1), the resource bundles are the
// only Korean prose this repository keeps — and neither gate opened them. A `ko`
// value sets a mood as easily as a comment did: measured 2026-08-15, one of them
// called a surface an orphan.
func TestBundleValuesAreWrittenDry(t *testing.T) {
	bundles := []struct {
		path  string
		value *regexp.Regexp
	}{
		{filepath.Join("frontend", "src", "i18n.ko.ts"), regexp.MustCompile(`:\s*"((?:[^"\\]|\\.)*)"`)},
	}
	for _, pattern := range []string{
		filepath.Join("core", "*", "messages.go"),
		filepath.Join("frameworks", "*", "messages.go"),
		filepath.Join("cmd", "*", "messages.go"),
	} {
		matches, err := filepath.Glob(pattern)
		if err != nil {
			t.Fatalf("globbing %s: %v", pattern, err)
		}
		for _, path := range matches {
			bundles = append(bundles, struct {
				path  string
				value *regexp.Regexp
			}{path, regexp.MustCompile("KO:\\s*[`\"]([^`\"]*)[`\"]")})
		}
	}

	var found []string
	for _, bundle := range bundles {
		body, err := os.ReadFile(bundle.path)
		if err != nil {
			continue
		}
		for index, line := range strings.Split(string(body), "\n") {
			match := bundle.value.FindStringSubmatch(line)
			if match == nil {
				continue
			}
			for _, word := range bannedKorean {
				if strings.Contains(match[1], word) {
					found = append(found, bundle.path+":"+itoa(index+1)+" "+word)
				}
			}
		}
	}
	if len(found) > 0 {
		t.Errorf("these bundle values use the banned register in %d places:\n%s\n"+
			"State the fact. A sentence a person reads is held to the same rule as a comment.",
			len(found), strings.Join(found, "\n"))
	}
}

// The English message table is prose the reader sees; its sentences follow the same register as
// the documents. Only the quoted values are scanned, not keys or code.
func TestEnglishMessagesAreWrittenDry(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("frontend", "src", "i18n.en.ts"))
	if err != nil {
		t.Fatal(err)
	}
	var found []string
	for number, line := range strings.Split(string(body), "\n") {
		colon := strings.Index(line, `": "`)
		if colon < 0 {
			continue
		}
		value := line[colon+4:]
		if match := bannedEnglish.FindString(value); match != "" {
			found = append(found, fmt.Sprintf("frontend/src/i18n.en.ts:%d %s", number+1, match))
		}
	}
	if len(found) > 0 {
		t.Fatalf("these messages use the banned register in %d places:\n%s\nState what a thing is, what is missing, and what to do about it.", len(found), strings.Join(found, "\n"))
	}
}
