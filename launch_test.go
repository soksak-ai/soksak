package main

import (
	"errors"
	"net"
	"testing"

	"github.com/soksak-ai/soksak-core/core/identity"
)

// A second process on one home must die while it is still invisible.
//
// Two copies of this application on screen is not a cosmetic problem: they
// disagree about who owns the store, and the operator reads the second one as
// the first behaving strangely. Measured 2026-08-15, twice — both times the
// window was believed to be closed.
func TestAWindowIsNeverDrawnBeforeTheHomeIsClaimed(t *testing.T) {
	taken := errors.New("another backend is already answering")
	drew := false

	err := launch(
		identity.Resolved{Socket: "<local-evidence>/does-not-matter.sock"},
		func(string) (net.Listener, error) { return nil, taken },
		func(net.Listener) error { drew = true; return nil },
	)

	if err == nil {
		t.Fatal("a second backend launched")
	}
	if !errors.Is(err, taken) {
		t.Errorf("the refusal lost its cause: %v", err)
	}
	if drew {
		t.Error("a window was drawn after the home was refused")
	}
}

// The claim is released when the application quits, or the next launch finds a
// socket nobody is behind and has to decide whether its owner is alive.
func TestTheClaimIsReleasedWhenTheApplicationStops(t *testing.T) {
	listener := &countingListener{}

	if err := launch(
		identity.Resolved{Socket: "<local-evidence>/does-not-matter.sock"},
		func(string) (net.Listener, error) { return listener, nil },
		func(net.Listener) error { return nil },
	); err != nil {
		t.Fatalf("launch: %v", err)
	}

	if listener.closed != 1 {
		t.Errorf("the listener was closed %d times, want once", listener.closed)
	}
}

// A failure from the framework is returned to the caller. Swallowing it would leave a
// process alive with no window and no way to tell.
func TestTheFrameworksFailureIsTheLaunchsFailure(t *testing.T) {
	refused := errors.New("no window")

	err := launch(
		identity.Resolved{Socket: "<local-evidence>/does-not-matter.sock"},
		func(string) (net.Listener, error) { return &countingListener{}, nil },
		func(net.Listener) error { return refused },
	)

	if !errors.Is(err, refused) {
		t.Errorf("launch answered %v", err)
	}
}

type countingListener struct{ closed int }

func (l *countingListener) Accept() (net.Conn, error) { return nil, net.ErrClosed }
func (l *countingListener) Close() error              { l.closed++; return nil }
func (l *countingListener) Addr() net.Addr            { return nil }

// The store is not opened until the home is claimed.
//
// A second process that lost the race still opened this installation's SQLite
// before it found out, and two writers on one database do not collide — the
// driver serialises them, so the damage is silent and the second process looks
// like it did nothing.
//
// Measured 2026-08-15: pid 66355, orphaned to launchd at 09:22 and invisible to
// every search for the application's name, held ~/.soksak-wails/soksak.db-shm
// open beside the live process for three hours.
//
// The store is opened inside the callback below, so this holds the real
// ordering: a refused claim means the callback never runs, and the database is
// never touched.
func TestTheStoreIsNotOpenedBeforeTheHomeIsClaimed(t *testing.T) {
	taken := errors.New("another backend is already answering")
	opened := false

	err := launch(
		identity.Resolved{Socket: "<local-evidence>/does-not-matter.sock"},
		func(string) (net.Listener, error) { return nil, taken },
		func(net.Listener) error { opened = true; return nil },
	)

	if err == nil {
		t.Fatal("a second backend launched")
	}
	if opened {
		t.Error("the store was opened after the home was refused")
	}
}
