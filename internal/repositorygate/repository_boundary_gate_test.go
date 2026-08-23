package repositorygate

import (
	"os"
	"testing"
)

func TestRepositoryDoesNotExecuteSiblingSources(t *testing.T) {
	root, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	findings, err := repositoryBoundaryFindings(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, finding := range findings {
		t.Error(finding)
	}
}
