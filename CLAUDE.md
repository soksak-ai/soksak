# CLAUDE.md

A bootloader. Procedures and commands are not duplicated here.

## Loading order

1. [`AGENTS.md`](AGENTS.md) — how to work in this repository
2. [`docs/README.md`](docs/README.md) — the document manifest
3. The canonical document the manifest points at for the area you are touching


## What this project is

A plugin-driven desktop workspace built on Wails v3. One recursive `leaf | split` tree of
panes; a leaf is a terminal or a browser surface. The core owns the frame, the command
registry, and the observation surfaces. It renders no concrete content — terminals, browsers,
and sidebar bodies come from plugins.
