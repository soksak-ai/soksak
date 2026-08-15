package wails

import (
	"strings"
	"testing"
)

// surfaceRuleFile holds the composition arithmetic and the command. It must
// stay answerable with nothing underneath it: the drift between a declaration
// and a native read-back is a subtraction, and a subtraction that can only be
// checked by starting a window is checked by nobody.
const surfaceRuleFile = "surface_composition.go"

// surfaceGroupFiles is everything this group owns.
var surfaceGroupFiles = []string{surfaceRuleFile, "surface_recorder.go"}

// The compositor is a separate module with its own release, and the framework
// is a vendor. Either one named in the rule file would make the coordinate
// arithmetic reachable only from inside this application — which is the one
// place a compositing verdict is least useful, because that is where the defect
// under investigation is.
func TestTheCompositionRuleNamesNoModuleUnderneathIt(t *testing.T) {
	source := readCode(t, surfaceRuleFile)
	for _, elsewhere := range []string{
		"wails-service-native-compositor", "compositor.", "nativesurface.",
		"wails/v3/pkg/application", "application.", "unsafe.",
	} {
		if strings.Contains(source, elsewhere) {
			t.Errorf("%s names %q; the drift arithmetic must answer with no compositor and no window",
				surfaceRuleFile, elsewhere)
		}
	}
}

// The caller passes what it read. A branch on the environment or the operating
// system here would make the same composition answer differently in a window,
// in a headless process and in a test, and the difference would only ever show
// up as one of the three being wrong.
func TestNothingInTheSurfaceGroupReadsAmbientState(t *testing.T) {
	for _, name := range surfaceGroupFiles {
		source := readCode(t, name)
		for _, ambient := range []string{"os.Getenv", "os.Getwd", "os.Executable", "runtime.GOOS"} {
			if strings.Contains(source, ambient) {
				t.Errorf("%s reads %s; the platform split is a build tag and everything else is an argument", name, ambient)
			}
		}
	}
}
