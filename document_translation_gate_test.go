package main

import (
	"os"
	"strings"
	"testing"
)

func TestReaderFacingContractDocumentsHaveKoreanTranslations(t *testing.T) {
	for _, canonical := range []string{
		"docs/README.md",
		"docs/tech/ARCHITECTURE.CHANGELOG.md",
		"docs/tech/CONTROL-PROTOCOL.CHANGELOG.md",
		"docs/tech/ENVIRONMENT-AND-INSTALLATION.md",
		"docs/tech/ENVIRONMENT-AND-INSTALLATION.CHANGELOG.md",
		"docs/tech/I18N.md",
		"docs/tech/RESTORE.CHANGELOG.md",
		"docs/tech/SIDEBAR.CHANGELOG.md",
	} {
		translation := strings.TrimSuffix(canonical, ".md") + ".ko.md"
		body, err := os.ReadFile(translation)
		if err != nil {
			t.Errorf("%s has no Korean translation: %v", canonical, err)
			continue
		}
		if !strings.Contains(string(body), "canonical: "+canonical) {
			t.Errorf("%s does not identify %s as canonical", translation, canonical)
		}
	}
}
