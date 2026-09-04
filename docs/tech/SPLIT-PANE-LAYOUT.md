# Split-pane Layout Rules

Status: In progress.

Production layout code follows the library state and geometry contract directly: `SplitPane` receives `SplitPaneState`, returns card rectangles and dividers, and structural changes call the library methods. React owns the pane chrome and plugin view contents around those rectangles.

This document defines the layout contract. Existing behavior and persisted shapes do not override these rules.
An implementation that fails a rule must be changed. If a rule is incorrect, this document must be corrected before
the implementation continues.

## 1. Ownership

- `SplitPaneState` is the only canonical layout state.
- Content panes, left and right sidebars, and rails use `CardInit`.
- Rectangles, dividers, rules, and hit testing use the public `SplitPane` API.
- React components and commands do not read internal grid arrays, private DOM state, or load order.

## 1.1 Repository boundaries

- Core, plugins, sidecars, kits, specs, contracts, and libraries are separate components.
- `environment.json` records installed components and versions. It does not define wiring.
- Component relationships are declared by manifest `runtimeDependencies`.
- Components exchange data only through the declared wire contract and exposed command, DOM, and status interfaces.
- Core tests use fakes and fixtures at the boundary. They do not inspect another component's source, paths, SDK, build,
  or implementation names.
- A component tests its own implementation in its own repository. Shared cases are defined by contracts and executed by
  the component that implements the contract.

## 2. Coordinates

- `xs` and `ys` contain the only layout boundaries.
- Cards that share a boundary reference the same line index.
- Coordinate comparisons do not identify shared lines. Epsilon grouping and post-layout line repair are prohibited.
- Rectangle calculation uses one `rects()` result for the layout snapshot.
- A card span cannot be crossed by another card. The layout must remain slicing.
- Gap is a plane rule and does not depend on card role.

## 3. Operations

- `split` replaces one card with two cards with explicit ids and payloads.
- `close` succeeds for every card except the last card.
- `move` is one atomic operation. Callers do not compose close and split.
- A rail is inserted or moved with `insertAt` and `moveTo`; it is not created by splitting a pane.
- Pixel size and fixed status are card properties.
- A failed operation leaves the complete state unchanged.

## 4. Persistence

- Persistence and restore use `SplitPaneState`.
- Invalid state is rejected with a structured error. No legacy conversion or repair is performed.
- Renderer-only ids are not persisted.

## 5. Validation

After every structural operation, validate:

1. All rectangles are finite and have positive area.
2. The cards cover the plane exactly.
3. Card intersections are empty.
4. Gaps match the plane gap rule.
5. The state is slicing.
6. Every card except the last card is closable.
7. Fixed card size and span are unchanged by layout operations.

Validation failure rejects the operation. The renderer does not hide the failure or defer it to a later operation.

## 5.1 Observation

- `layout.verify` reports declared and measured rectangles with numeric deltas.
- `ui.measure` reports the measured DOM rectangle for an exposed address.
- `window.snapshot` captures pixels without changing window focus.
- `window.record` records finite frames without changing window focus or animation state.
- Capture and recording are observation tools. Their images do not determine pass or fail.
- Animation and composition checks use frame records and numeric position deltas for pass or fail.
- Event notifications define completion. Polling and timer-based completion are not primary mechanisms.
- Test artifacts are stored by the repository test or command contract. Untracked temporary scripts and temporary test
  folders are not part of the verification procedure.
- Symlinks are not used. Paths are resolved from declared configuration or discovered interfaces.

## 6. Completion criteria

The completed implementation has one layout state contract, direct `SplitPane` operations, and no
tree conversion, fallback layout, or coordinate repair path.
