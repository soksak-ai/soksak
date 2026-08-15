package process

import (
	"strings"
	"testing"
)

// A host that cannot honour process groups refuses the option by name.
//
// Guarding the group flag by platform and spawning
// ungrouped everywhere else. That silence is the exact shape of its worst
// measured bug — grandchildren holding stdout, so a stop was hostage to a
// sleeping grandchild. A spawn that cannot honour the ownership it was asked
// for has to say so.
func TestAHostThatCannotHonourGroupsRefusesByName(t *testing.T) {
	err := groupRefusal(false, "there is no process group to signal here")
	if err == nil {
		t.Fatal("a host that cannot group children must refuse, not spawn one ungrouped")
	}
	if !strings.Contains(err.Error(), "group") {
		t.Fatalf("error %q must name the option it refuses", err)
	}
	if !strings.Contains(err.Error(), "there is no process group to signal here") {
		t.Fatalf("error %q must carry why this host cannot honour it", err)
	}
}

func TestAHostThatHonoursGroupsAcceptsThem(t *testing.T) {
	if err := groupRefusal(true, ""); err != nil {
		t.Fatalf("a host that groups children must accept the option: %v", err)
	}
}

// The wiring is a build-tag constant rather than a runtime.GOOS branch, and a
// host that declines the option owes a reason — an unexplained refusal sends
// the caller looking for a bug that is a platform fact.
func TestThisHostDeclaresWhetherItHonoursGroups(t *testing.T) {
	if groupHonoured && groupNotHonouredBecause != "" {
		t.Fatalf("this host honours groups but also explains why it does not: %q", groupNotHonouredBecause)
	}
	if !groupHonoured && groupNotHonouredBecause == "" {
		t.Fatal("this host refuses groups without saying why")
	}
}
