//go:build !darwin

package wails

// platformBurst is nil where no stream backend exists; a burst then fails by name.
func platformBurst() burstSource { return nil }
