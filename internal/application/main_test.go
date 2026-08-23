package application

import (
	"os"
	"testing"

	"github.com/soksak-ai/soksak-core/internal/repositoryroot"
)

func TestMain(m *testing.M) {
	root, err := repositoryroot.Discover(".")
	if err != nil {
		panic(err)
	}
	if err := os.Chdir(root); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}
