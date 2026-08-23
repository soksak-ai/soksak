package wails

import (
	"strings"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// No plugin id is on the host's service list.
//
// A service reports its own name and the framework registers whatever it reports. So the name that
// ends up here is decided by the value, and the value can come from anywhere — including a file this
// repository does not hold.
//
// The services are constructed with nothing behind them. Nothing is started and no method but the name
// is called, which is the whole point: what a service calls itself is a property of the value, not
// of a running application, so the reading needs no window.
func TestNoPluginIdIsOnTheHostsServiceList(t *testing.T) {
	for _, service := range hostServices(&reaperService{name: "session-reaper"}, nil, nil, nil, nil) {
		named, reports := service.Instance().(application.ServiceName)
		if !reports {
			// A service with no name is registered under its Core-owned type name.
			continue
		}
		name := named.ServiceName()
		if strings.Contains(name, "soksak-plugin-") {
			t.Errorf("a host service uses plugin identity %q; host services name domain-neutral capabilities", name)
		}
	}
}
