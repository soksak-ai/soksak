package repositorygate

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestActiveDocumentsDescribeOnlyTheCurrentProduct(t *testing.T) {
	retiredIdentifiers := []string{
		"settings.json",
		"installed.json",
		"development_set",
		"provider_set",
		"soksak-plugin-browser-native",
	}
	historicalNarration := []string{
		"used to",
		"written before",
		"older text",
		"there was",
		"was removed",
		"were removed",
		"went with it",
		"earlier note",
		"stays deleted",
		"until 20",
	}

	err := filepath.WalkDir("docs", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || filepath.Ext(path) != ".md" || strings.HasSuffix(path, ".ko.md") {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		text := strings.ToLower(string(body))
		if documentKind(text) == "changelog" {
			return nil
		}
		for _, forbidden := range append(retiredIdentifiers, historicalNarration...) {
			if strings.Contains(text, forbidden) {
				t.Errorf("%s preserves product history through %q", path, forbidden)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestDesignHistoryIsSeparatedFromCurrentContracts(t *testing.T) {
	err := filepath.WalkDir("docs", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() || filepath.Ext(path) != ".md" || strings.HasSuffix(path, ".ko.md") {
			return nil
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		text := string(body)
		if documentKind(text) == "changelog" {
			for _, required := range []string{
				"kind: changelog",
				"status: historical",
				"canonical: docs/",
				"The current contract is [",
				"## Evidence",
			} {
				if !strings.Contains(text, required) {
					t.Errorf("%s lacks %q", path, required)
				}
			}
			canonicalLine := ""
			for _, line := range strings.Split(text, "\n") {
				if strings.HasPrefix(line, "canonical: docs/") {
					canonicalLine = strings.TrimPrefix(line, "canonical: ")
					break
				}
			}
			if canonicalLine == "" {
				t.Errorf("%s has no canonical path", path)
			} else if _, statErr := os.Stat(canonicalLine); statErr != nil {
				t.Errorf("%s has no canonical document %s", path, canonicalLine)
			}
			return nil
		}
		frontMatter := text
		if end := strings.Index(strings.TrimPrefix(text, "---\n"), "\n---\n"); end >= 0 {
			frontMatter = strings.TrimPrefix(text, "---\n")[:end]
		}
		if strings.Contains(frontMatter, "status: historical") {
			t.Errorf("%s stores history outside an adjacent changelog", path)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func documentKind(text string) string {
	if !strings.HasPrefix(text, "---\n") {
		return ""
	}
	frontMatter := strings.TrimPrefix(text, "---\n")
	end := strings.Index(frontMatter, "\n---\n")
	if end < 0 {
		return ""
	}
	for _, line := range strings.Split(frontMatter[:end], "\n") {
		if strings.HasPrefix(line, "kind: ") {
			return strings.TrimSpace(strings.TrimPrefix(line, "kind: "))
		}
	}
	return ""
}
