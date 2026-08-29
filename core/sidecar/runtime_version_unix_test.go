//go:build unix

package sidecar

import (
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/soksak-ai/soksak-core/core/process"
)

func TestNameResolutionPreservesTheSelectedVersion(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	path, err := testSidecarResolver(home)("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	deps := Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second,
	}
	field := reflect.ValueOf(&deps).Elem().FieldByName("ResolveUnit")
	if !field.IsValid() || field.Kind() != reflect.Func || field.Type().NumIn() != 1 || field.Type().NumOut() != 2 {
		t.Fatal("sidecar Deps does not resolve name, version, and process as one selection")
	}
	field.Set(reflect.MakeFunc(field.Type(), func(input []reflect.Value) []reflect.Value {
		if input[0].String() != "fake-unit" {
			t.Fatalf("resolved unexpected unit %q", input[0].String())
		}
		return []reflect.Value{
			reflect.ValueOf(Resolved{Name: "fake-unit", Version: "0.0.30", Path: path}),
			reflect.Zero(field.Type().Out(1)),
		}
	}))
	host := NewHost(deps)
	t.Cleanup(func() { host.StopAll() })
	opened, err := host.Start("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	if opened.Version != "0.0.30" {
		t.Fatalf("generic start discarded selected version: %+v", opened)
	}
}

func TestResolvedVersionReplacesRunningUnit(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	path, err := testSidecarResolver(home)("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	host := NewHost(Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second,
	})
	t.Cleanup(func() { host.StopAll() })
	version := "0.0.11"
	registration := Registration{
		Host: host,
		Resolve: func(Consumer, DependencyReference) (Resolved, error) {
			return Resolved{Name: "fake-unit", Version: version, Path: path}, nil
		},
	}

	first, err := registration.openWithSecrets(
		Consumer{ID: "terminal", Version: "0.0.1"},
		DependencyReference{ID: "fake-unit", Version: version}, "", nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	version = "0.0.12"
	second, err := registration.openWithSecrets(
		Consumer{ID: "terminal", Version: "0.0.1"},
		DependencyReference{ID: "fake-unit", Version: version}, "", nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if second.PID == first.PID {
		t.Fatalf("sidecar %s was reused across versions 0.0.11 and 0.0.12 at pid %d", first.Name, first.PID)
	}
}

func TestResolvedVersionReplacesAdoptedUnit(t *testing.T) {
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	path, err := testSidecarResolver(home)("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	registration := func(host *Host, version string) Registration {
		return Registration{
			Host: host,
			Resolve: func(Consumer, DependencyReference) (Resolved, error) {
				return Resolved{Name: "fake-unit", Version: version, Path: path}, nil
			},
		}
	}
	deps := Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second,
	}
	firstHost := NewHost(deps)
	first, err := registration(firstHost, "0.0.11").openWithSecrets(
		Consumer{ID: "terminal", Version: "0.0.1"},
		DependencyReference{ID: "fake-unit", Version: "0.0.11"}, "", nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := firstHost.Release("fake-unit"); err != nil {
		t.Fatal(err)
	}

	secondHost := NewHost(deps)
	t.Cleanup(func() { secondHost.StopAll() })
	second, err := registration(secondHost, "0.0.12").openWithSecrets(
		Consumer{ID: "terminal", Version: "0.0.1"},
		DependencyReference{ID: "fake-unit", Version: "0.0.12"}, "", nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if second.PID == first.PID {
		t.Fatalf("sidecar %s adopted version 0.0.11 for a 0.0.12 requirement at pid %d", first.Name, first.PID)
	}
}
