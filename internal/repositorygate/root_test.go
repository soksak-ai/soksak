package repositorygate

import (
	"os"
	"testing"

	"github.com/soksak-ai/soksak-core/internal/repositoryroot"
)

var repositoryRoot string

func TestMain(m *testing.M) {
	root, err := repositoryroot.Discover(".")
	if err != nil {
		panic(err)
	}
	repositoryRoot = root
	if err := os.Chdir(root); err != nil {
		panic(err)
	}
	os.Exit(m.Run())
}
