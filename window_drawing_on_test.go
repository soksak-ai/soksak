//go:build motion

package main

// See window_drawing_off_test.go: with the `motion` tag the window's own drawing is judged, which is
// only a fact about this application on a machine that is doing nothing else.
const judgeDrawing = true
