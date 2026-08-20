package wails

import (
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// No unit's id is on the host's service list.
//
// A service reports its own name and the framework registers whatever it reports. So the name that
// ends up here is decided by the value, and the value can come from anywhere — including a file this
// repository does not hold.
//
// That is what happened. Until 2026-08-20 one service answered `soksak-plugin-browser-native`, and
// `coupling_gate_test.go` — which walks core sources for exactly that string — stayed green the
// whole time: the literal was written in the unit's own file, outside every scanned root, and
// arrived here only when the value was registered. A scan finds where a name is written. This reads
// where it arrives.
//
// The services are constructed with nil dependencies. Nothing is started and no method but the name
// is called, which is the whole point: what a service calls itself is a property of the value, not
// of a running application, so the reading needs no window.
func TestNoUnitIdIsOnTheHostsServiceList(t *testing.T) {
	for _, service := range hostServices(nil, nil, nil, nil, nil) {
		named, reports := service.Instance().(application.ServiceName)
		if !reports {
			// A service with no name of its own is registered under its type name, which this
			// repository owns. There is nothing for a unit id to arrive through.
			continue
		}
		name := named.ServiceName()
		if strings.Contains(name, "soksak-plugin-") {
			t.Errorf("a service registered under a unit id puts that id on the host's service list: %q\n"+
				"A host service names the capability it is. Every unit holding the matching permission is\n"+
				"served by it, so naming it after one of them describes where the file sits rather than\n"+
				"what the service does — and C1 refuses a unit id in the core's run-time surface.", name)
		}
	}
}
