//go:build !windows

package sidecar

import (
	"os"
	"testing"
	"time"

	"github.com/soksak-ai/soksak-core/core/process"
)

type testVault struct{}

func (testVault) Resolve(namespace, key string) (string, error) {
	return "sealed-" + namespace + "-" + key, nil
}

func secretHost(t *testing.T) (*Host, string) {
	t.Helper()
	home := shortHome(t)
	runtimeRoot := shortHome(t)
	stageUnit(t, home, "fake-unit", fakeUnitSource)
	resolved, err := testSidecarResolver(home)("fake-unit")
	if err != nil {
		t.Fatal(err)
	}
	path := resolved.Path
	host := NewHost(Deps{
		Home: home, Runtime: runtimeRoot, Spawner: process.OSSpawner{}, Environment: os.Environ(),
		Dial: dialUnix, ReadyWithin: 10 * time.Second,
	})
	host.SetSecrets(testVault{})
	t.Cleanup(func() { host.StopAll() })
	return host, path
}

// A caller that declares no secrets has no opinion; it adopts what runs
// rather than refusing it.
func TestAnEmptyDeclarationAdoptsTheRunningSecretfulUnit(t *testing.T) {
	host, path := secretHost(t)
	first, err := host.StartResolvedWithSecrets("fake-unit", "", path, "ns", map[string]string{"UNIT_KEY": "checkpoint"})
	if err != nil {
		t.Fatal(err)
	}
	second, err := host.StartResolvedWithSecrets("fake-unit", "", path, "", nil)
	if err != nil {
		t.Fatalf("an empty declaration was refused: %v", err)
	}
	if second.PID != first.PID {
		t.Fatalf("an empty declaration restarted the unit: %d then %d", first.PID, second.PID)
	}
}

// A unit running without secrets cannot serve the caller that requires them:
// the first real declaration restarts it.
func TestASecretDeclarationRestartsAKeylessUnit(t *testing.T) {
	host, path := secretHost(t)
	first, err := host.StartResolvedWithSecrets("fake-unit", "", path, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	second, err := host.StartResolvedWithSecrets("fake-unit", "", path, "ns", map[string]string{"UNIT_KEY": "checkpoint"})
	if err != nil {
		t.Fatalf("the declaration was refused instead of restarting the keyless unit: %v", err)
	}
	if second.PID == first.PID {
		t.Fatalf("the keyless unit %d kept running under a secret declaration", first.PID)
	}
}

// Two different real declarations stay a refusal — the rule that catches a
// misconfigured second caller keeps its teeth.
func TestTwoRealDeclarationsStillMismatch(t *testing.T) {
	host, path := secretHost(t)
	if _, err := host.StartResolvedWithSecrets("fake-unit", "", path, "ns", map[string]string{"UNIT_KEY": "checkpoint"}); err != nil {
		t.Fatal(err)
	}
	if _, err := host.StartResolvedWithSecrets("fake-unit", "", path, "ns", map[string]string{"OTHER": "key"}); err == nil {
		t.Fatal("a different real declaration was accepted")
	}
}
