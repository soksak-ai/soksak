package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Prose in this repository is dry, short and exact. The words below carry a
// different register — they give code intentions and senses it does not have —
// and they were corrected four times on 2026-08-15 before this gate existed.
//
// Scope: documents this repository authors (docs/tech, docs/manual) and the
// working agreement's own rule file is not scanned because it lists the words.
// Code comments are not scanned yet: the inherited frontend carries thousands of
// lines in the old register, and a gate that fails on all of them at once blocks
// every unrelated change. That sweep is separate work.
var banned = []string{
	"산다", "말한다", "돈다", "센다", "싣는다", "싣고", "흘린다", "흘려보낸",
	"꽂으면", "달고", "가리킨다", "밝힌다", "고아", "물어야", "1급",
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
				for _, word := range banned {
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
