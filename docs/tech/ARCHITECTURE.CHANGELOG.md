---
kind: changelog
status: historical
canonical: docs/tech/ARCHITECTURE.md
---

# Architecture design flow

The current contract is [ARCHITECTURE.md](./ARCHITECTURE.md). This document explains the major
decisions produced by the Core census.

## Domain features left Core

Core contained behavior for files, agent conversations, terminals, media playlists, and a file
explorer. Each feature worked for its first consumer but forced later consumers through the first
feature's assumptions. A browser-like view and a terminal-like view could not reuse those paths
without pretending to be the original feature.

The census established a durable test: Core owns a domain-neutral mechanism only when it cannot
cross the plugin boundary or several plugins would otherwise recreate it. Meaning and user behavior
belong to plugins. File viewing, terminal interpretation, conversations, and media policy therefore
moved behind plugin commands and capabilities.

## File drops became owner-bound grants

The first drop implementation converted file paths into shell command text inside Core. That made
Core name terminal shell families and violated the same domain boundary. The stable host mechanism
is an opaque, Plugin/window-bound, one-shot grant. Redemption returns the authorized raw path;
Terminal Kit, an editor, or another consumer applies its own meaning. The Core coupling gate found
and rejected the shell-specific implementation before the application gate ran.

## Installed components replaced source-tree composition

Core linked specific plugin packages and found neighboring repositories during builds. That made
checkout layout part of the product and meant adding a plugin required rebuilding Core. The boundary
changed to published packages for build-time relationships and `environment.json` for runtime
selection. Core now assembles only what the installed environment declares.

## PTY became a capability backed by a sidecar

A PTY was initially treated as something the Core process had to own. Measurement showed that a
separate process owned the PTY master and Core received bytes through a public protocol. The stable
concept is the PTY capability, while its implementation is an installed sidecar. This keeps terminal
policy in plugins and permits another implementation without editing Core.

## Evidence

Coupling gates reject domain names and concrete plugin dependencies in Core. Repository-boundary
gates reject sibling-source discovery. Installed-product tests own end-to-end host and sidecar
verification.
