package main

import (
	"os"
	"testing"

	composition "github.com/soksak-ai/soksak-contract-composition"
)

func TestRepositoryDoesNotExecuteSiblingUnitSources(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	findings, err := composition.CheckRepositoryBoundary(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, finding := range findings {
		t.Errorf("%s:%d %s %s", finding.Path, finding.Line, finding.Rule, finding.Value)
	}
}
