package control

import "fmt"

// The receipt this process signs before it is allowed to quit.
//
// Quitting destroys the channel the answer would come back on, so the caller
// requests the receipt first and only then stops the process. That makes the
// receipt the last observation anyone gets: if it states "reaped" while a
// child is still running, nothing downstream will ever contradict it. So the
// signature is withheld rather than stamped — a count that cannot be true, or
// anything still held, is an error naming what remains.

// phaseReaped is the only phase a signed receipt holds. It exists as a
// constant so the caller's check and this build's answer are one string.
const phaseReaped = "reaped"

// Generation is what letting go of this process's execution generation
// actually released.
//
// Every field is a count of things that no longer exist because this call ran.
// A host that owns none of a kind reports zero for it, which is true; a host
// that owns some and does not look reports zero too, which is why the launcher
// supplies one function covering all of them rather than a field per
// subsystem that can be left out one at a time.
type Generation struct {
	ProcessChildren       int `json:"processChildrenReaped"`
	LocalPTYs             int `json:"localPtysReaped"`
	DaemonPTYsTransferred int `json:"daemonPtysTransferred"`
	Daemons               int `json:"daemonsReaped"`
	Services              int `json:"servicesReaped"`
	NativeWindows         int `json:"nativeWindowsDrained"`
	NativeSurfaces        int `json:"nativeSurfacesDrained"`
	NativePaneHosts       int `json:"nativePaneHostsDrained"`
	NativeInputMonitors   int `json:"nativeInputMonitorsDrained"`
	// Remaining is what is still held after the drain. Anything but zero means
	// the generation was not released and this process must not be told to
	// quit yet.
	Remaining int `json:"nativeRemaining"`
}

// ShutdownReceipt is the signed answer. The counts are inlined beside the
// signature because the caller reads them as one record.
type ShutdownReceipt struct {
	Phase  string `json:"phase"`
	Reaped bool   `json:"reaped"`
	Generation
}

func registerShutdown(registry *Registry, deps Deps) {
	if deps.ReleaseGeneration == nil {
		refuse(registry, commandShutdownPrepare,
			"this process was given no way to release what it started, so it cannot sign a shutdown receipt")
		return
	}

	registry.MustRegister(Command{
		Name:  commandShutdownPrepare,
		Owner: OwnerCore,
		Handler: func(Args) (any, error) {
			released, err := deps.ReleaseGeneration()
			if err != nil {
				return nil, fmt.Errorf("releasing the execution generation: %w", err)
			}
			return sign(released)
		},
	})
}

// sign turns counts into a receipt, or refuses to.
func sign(released Generation) (ShutdownReceipt, error) {
	for _, count := range []struct {
		name  string
		value int
	}{
		{"processChildrenReaped", released.ProcessChildren},
		{"localPtysReaped", released.LocalPTYs},
		{"daemonPtysTransferred", released.DaemonPTYsTransferred},
		{"daemonsReaped", released.Daemons},
		{"servicesReaped", released.Services},
		{"nativeWindowsDrained", released.NativeWindows},
		{"nativeSurfacesDrained", released.NativeSurfaces},
		{"nativePaneHostsDrained", released.NativePaneHosts},
		{"nativeInputMonitorsDrained", released.NativeInputMonitors},
		{"nativeRemaining", released.Remaining},
	} {
		if count.value < 0 {
			// A negative count is a subsystem that lost track, not a shutdown
			// that went unusually well.
			return ShutdownReceipt{}, fmt.Errorf(
				"%s: %s is %d; a count of what was released is never negative",
				commandShutdownPrepare, count.name, count.value)
		}
	}
	if released.Remaining != 0 {
		return ShutdownReceipt{}, fmt.Errorf(
			"%s: %d native object(s) are still held after the drain; the execution generation was not released",
			commandShutdownPrepare, released.Remaining)
	}
	return ShutdownReceipt{Phase: phaseReaped, Reaped: true, Generation: released}, nil
}
