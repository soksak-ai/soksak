//go:build !windows

package sidecar

import (
	"os"
	"testing"
	"time"

	"github.com/soksak-ai/soksak-core/core/process"
)

func TestServiceShutdownStopsEveryStartedUnit(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	host := NewHost(Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
	})

	started, err := host.Start("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	if err := host.ServiceShutdown(); err != nil {
		t.Fatal(err)
	}
	if !processGone(started.PID) {
		t.Fatalf("ServiceShutdown returned while pid %d was running", started.PID)
	}
	recorded, err := host.Recorded()
	if err != nil {
		t.Fatal(err)
	}
	if len(recorded) != 0 {
		t.Fatalf("ServiceShutdown retained unit records: %+v", recorded)
	}
}

func TestServiceShutdownStopsARecordedUnit(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	deps := Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second, ResolveUnit: testSidecarResolver(home),
	}
	first := NewHost(deps)
	t.Cleanup(func() { first.StopAll() })
	started, err := first.Start("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Release("fake-unit"); err != nil {
		t.Fatal(err)
	}

	second := NewHost(deps)
	if err := second.ServiceShutdown(); err != nil {
		t.Fatal(err)
	}
	if second.answers(started.Address) {
		t.Fatalf("ServiceShutdown returned while recorded unit %s accepted connections", started.Name)
	}
	recorded, err := second.Recorded()
	if err != nil {
		t.Fatal(err)
	}
	if len(recorded) != 0 {
		t.Fatalf("ServiceShutdown retained recorded units: %+v", recorded)
	}
}
