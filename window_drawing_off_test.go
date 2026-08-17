//go:build !motion

package main

// Whether this build judges how the window draws.
//
// A window that stops drawing while the layout changes is a defect of this application, and a window
// that stops drawing because the machine is running four other test binaries is not. The two produce
// the same number, so the judgement is made where the machine is quiet: `task verify:motion` builds
// with the `motion` tag and this becomes true.
//
// Off, the stall is still measured and still written down — what changes is that it does not fail a
// suite that runs its gates beside each other.
const judgeDrawing = false
