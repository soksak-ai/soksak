package wails

import (
	"io"
	"log"
	"os"
)

type PresentationMode string

const (
	PresentationInteractive PresentationMode = "interactive"
	PresentationCaptureOnly PresentationMode = "capture-only"
)

// endWithSpawner quits the application once the channel from whoever started it ends.
//
// Reads until the far end closes, then calls quit once. Bytes are discarded: nothing is sent on this
// channel and reading it for content would give the spawner a second way to drive the application,
// beside the control plane that already answers everything.
//
// A read error is the same event as a clean end. Both mean the far end is not there, and a launch
// that stayed up on the difference would be exactly the process this exists to prevent.
func endWithSpawner(channel io.ReadCloser, quit func()) {
	defer channel.Close()
	buffer := make([]byte, 256)
	for {
		if _, err := channel.Read(buffer); err != nil {
			quit()
			return
		}
	}
}

// watchSpawner starts the watch for an unattended launch, and does nothing for an attended one.
//
// A person's application does not quit because a terminal closed — it was opened from somewhere and
// outlives it, which is what an application is.
func watchSpawner(presentation PresentationMode, quit func()) {
	if presentation == PresentationInteractive {
		return
	}
	go endWithSpawner(os.Stdin, func() {
		log.Println("the launch's channel ended and nobody is watching this window — quitting")
		quit()
	})
}
