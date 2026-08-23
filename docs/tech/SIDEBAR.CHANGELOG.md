---
kind: changelog
status: historical
canonical: docs/tech/SIDEBAR.md
---

# Sidebar design flow

The current contract is [SIDEBAR.md](./SIDEBAR.md).

## Why plugins declare surfaces, not places

Plugin manifests selected concrete regions. That let a plugin arrange the user's window and made
the same side view different merely because it stood on the left or right. Projection fields also
allowed one content plugin to decide which other plugin appeared beside it.

The contract now separates capability from arrangement. A plugin declares whether a view can appear
as a content tab, a side view, or both. The workspace owns the actual region, split, tab order, and
persistence. Unknown manifest fields are refused rather than translated into assumed placement.

## Evidence

Manifest gates accept only the current surface grammar. Layout and restore gates prove that moving
a side view does not change plugin identity or let native content cross the rail.
