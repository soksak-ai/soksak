package sidecar

import (
	"strconv"
	"time"
)

func stopTimeoutSeconds(within time.Duration) string {
	return strconv.FormatFloat(within.Seconds(), 'f', -1, 64)
}
