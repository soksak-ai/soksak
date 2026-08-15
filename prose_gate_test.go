package main

import (
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

// commentLine matches a line that is only a comment. A banned word inside a
// string literal is data — a refusal message, a test fixture — and rewriting it
// would change what the program does.
var commentLine = regexp.MustCompile(`^\s*(//|\*|/\*)`)

// scannedCode is every extension whose comments this repository authors.
var scannedCode = map[string]bool{
	".go": true, ".ts": true, ".tsx": true,
}

// skippedTrees are trees this repository does not author, or that are not the
// first line.
var skippedTrees = map[string]bool{
	"node_modules": true, "dist": true, ".git": true, "bin": true,
	"bindings": true,
}

// koreanCommentDebt is how many Korean comment lines in the frontend still use
// the banned register, measured 2026-08-15.
//
// It is a ratchet, not an exemption. Every one of these is already a violation
// of a different rule — comments are English (§6-1) — and they disappear as that
// translation lands. Until then the number may only go down: a new one fails
// this gate, and lowering the register in an existing file fails it too.
//
// Zero here means the debt is gone and this constant goes with it.
const koreanCommentDebt = 212

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
		if !scannedCode[filepath.Ext(path)] {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		scanned++
		for index, line := range strings.Split(string(body), "\n") {
			if !commentLine.MatchString(line) {
				continue
			}
			if word := bannedEnglish.FindString(line); word != "" {
				found = append(found, path+":"+itoa(index+1)+" "+word)
			}
			for _, word := range bannedKorean {
				if strings.Contains(line, word) {
					korean = append(korean, path+":"+itoa(index+1)+" "+word)
				}
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("scanning the tree: %v", err)
	}

	if scanned == 0 {
		t.Fatal("no source files were scanned; the extensions are wrong")
	}
	if len(found) > 0 {
		t.Errorf("these comments use the banned register in %d places:\n%s\n"+
			"State what a thing is, what is missing, and what to do about it.",
			len(found), strings.Join(found, "\n"))
	}
	if len(korean) > koreanCommentDebt {
		t.Errorf("Korean comments in the banned register went from %d to %d.\n%s\n"+
			"The count may only go down. Rewrite the comment in English, dry.",
			koreanCommentDebt, len(korean), strings.Join(korean[koreanCommentDebt:], "\n"))
	}
	if len(korean) < koreanCommentDebt {
		t.Errorf("Korean comments in the banned register are down to %d from %d.\n"+
			"Lower koreanCommentDebt to %d so the ratchet holds the new floor.",
			len(korean), koreanCommentDebt, len(korean))
	}
}
