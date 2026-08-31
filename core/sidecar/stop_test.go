package sidecar

import (
	"testing"
	"time"
)

func TestStopTimeoutFormatsSecondsWithoutDuplicatingTheUnit(t *testing.T) {
	if got := stopTimeoutSeconds(1500 * time.Millisecond); got != "1.5" {
		t.Fatalf("seconds=%q", got)
	}
}
