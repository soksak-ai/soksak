package daemon

import (
	"encoding/json"
	"strings"
	"testing"
)

func decodeTrigger(t *testing.T, encoded string) (Trigger, error) {
	t.Helper()
	var trigger Trigger
	if err := json.Unmarshal([]byte(encoded), &trigger); err != nil {
		t.Fatalf("decoding %s: %v", encoded, err)
	}
	return trigger, trigger.check()
}

func TestAnAbsoluteTriggerFiresAtWhatItSaid(t *testing.T) {
	trigger, err := decodeTrigger(t, `{"kind":"at","at":1750000000000}`)
	if err != nil {
		t.Fatalf("checking: %v", err)
	}

	first := trigger.first(1_000)
	if first == nil || *first != 1750000000000 {
		t.Fatalf("first = %v, want the moment it named", first)
	}
}

// A time that has already passed is not an error: a plugin re-arming what it
// stored while the app was closed means "as soon as you can".
func TestAnAbsoluteTriggerInThePastIsDueRatherThanRefused(t *testing.T) {
	trigger, err := decodeTrigger(t, `{"kind":"at","at":500}`)
	if err != nil {
		t.Fatalf("checking: %v", err)
	}
	if first := trigger.first(1_000); first == nil || *first != 500 {
		t.Fatalf("first = %v, want the past moment so it fires at the next wake", first)
	}
}

// Without an anchor the interval starts now. Firing at registration as well
// would make an every-minute job fire twice in the first minute.
func TestAnIntervalTriggerFirstFiresOneIntervalOn(t *testing.T) {
	trigger, err := decodeTrigger(t, `{"kind":"every","every_ms":60000}`)
	if err != nil {
		t.Fatalf("checking: %v", err)
	}
	if first := trigger.first(1_000); first == nil || *first != 61_000 {
		t.Fatalf("first = %v, want one interval from now", first)
	}
}

// An anchor is a grid, and the point of the grid is that the fire time does not
// drift with when the job happened to be registered.
func TestAnAnchoredIntervalLandsOnTheGrid(t *testing.T) {
	trigger, err := decodeTrigger(t, `{"kind":"every","every_ms":1000,"anchor":500}`)
	if err != nil {
		t.Fatalf("checking: %v", err)
	}

	if first := trigger.first(2_300); first == nil || *first != 2_500 {
		t.Fatalf("first = %v, want the next grid point after 2300", first)
	}
	if next := trigger.after(2_500); next == nil || *next != 3_500 {
		t.Fatalf("after = %v, want the following grid point", next)
	}
}

// A reconcile job is an event trigger. Firing it at registration is the boot
// scan the caller requested; after that it waits to be poked and never sleeps
// against a clock.
func TestAReconcileTriggerIsDueAtOnceAndThenWaits(t *testing.T) {
	trigger, err := decodeTrigger(t, `{"kind":"reconcile"}`)
	if err != nil {
		t.Fatalf("checking: %v", err)
	}
	if first := trigger.first(1_000); first == nil || *first != 1_000 {
		t.Fatalf("first = %v, want the registration scan", first)
	}
	if next := trigger.after(1_000); next != nil {
		t.Fatalf("after = %v, want nothing until it is poked", next)
	}
}

func TestATriggerThisBuildCannotHonourIsRefusedByName(t *testing.T) {
	cases := []struct {
		encoded string
		says    string
	}{
		{`{"kind":"cron","expr":"*/5 * * * *"}`, "cron"},
		{`{"kind":"at"}`, "at"},
		{`{"kind":"every"}`, "every_ms"},
		{`{"kind":"every","every_ms":0}`, "every_ms"},
		{`{"kind":"every","every_ms":-5}`, "every_ms"},
		{`{"kind":"whenever"}`, "whenever"},
		{`{}`, "kind"},
	}
	for _, one := range cases {
		var trigger Trigger
		if err := json.Unmarshal([]byte(one.encoded), &trigger); err != nil {
			t.Fatalf("decoding %s: %v", one.encoded, err)
		}
		err := trigger.check()
		if err == nil {
			t.Errorf("%s was accepted", one.encoded)
			continue
		}
		if !strings.Contains(err.Error(), one.says) {
			t.Errorf("%s was refused with %q, which does not say %q", one.encoded, err, one.says)
		}
	}
}

// The list answers with the trigger the caller registered, in the shape it
// registered it in: a caller comparing what it stored with what came back must
// not find a different document.
func TestATriggerComesBackAsItWasSent(t *testing.T) {
	for _, encoded := range []string{
		`{"kind":"at","at":1750000000000}`,
		`{"kind":"every","every_ms":60000,"anchor":500}`,
		`{"kind":"reconcile"}`,
	} {
		trigger, err := decodeTrigger(t, encoded)
		if err != nil {
			t.Fatalf("checking %s: %v", encoded, err)
		}
		again, err := json.Marshal(trigger)
		if err != nil {
			t.Fatalf("encoding: %v", err)
		}
		if string(again) != encoded {
			t.Errorf("%s came back as %s", encoded, again)
		}
	}
}

func TestBackoffGrowsAndStopsAtTheCallersCeiling(t *testing.T) {
	retry := Retry{Max: 5, BaseMS: 1_000, MaxMS: 4_000}

	for attempt, want := range map[int]int64{1: 1_000, 2: 2_000, 3: 4_000, 4: 4_000, 9: 4_000} {
		if got := retry.wait(attempt); got != want {
			t.Errorf("attempt %d waits %dms, want %dms", attempt, got, want)
		}
	}
}
