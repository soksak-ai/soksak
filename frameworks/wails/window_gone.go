package wails

import (
	"github.com/wailsapp/wails/v3/pkg/application"
)

// WindowGoneEvent is the one fact this host has about a window that is closing: which one.
//
// A fact rather than an instruction. The host invoked a command named for terminals until
// 2026-08-20 — a host with an opinion about what a terminal is — and it broke silently when that
// command left with the plugin that registered it. What is published now is what happened, and what
// to do about it is for whoever kept something under that window.
//
// Every window is told, including the one that is going. A document about to be torn down acting on
// it changes nothing, and filtering here would put the choice of which documents care in this host.
const WindowGoneEvent = "window:gone"

// WindowGone names the window in a way a document can compare against what it holds.
type WindowGone struct {
	// WindowLabel is the name this application gave the window. It is opaque to everything between
	// here and whoever kept something under it.
	WindowLabel string `json:"windowLabel"`
}

func init() {
	application.RegisterEvent[WindowGone](WindowGoneEvent)
}
