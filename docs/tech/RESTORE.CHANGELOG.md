---
kind: changelog
status: historical
canonical: docs/tech/RESTORE.md
---

# Restore design flow

The current contract is [RESTORE.md](./RESTORE.md).

## Why invalid records are not repaired

A cold restore stopped after encountering a record with a different shape. One unreadable record
prevented every valid window after it from reopening. Adding missing fields during reading looked
protective, but it created a second data model and silently invented durable identity.

Restore now validates each record independently. A record outside the current shape is named, left
unchanged, and skipped; the remaining records continue. The reader never migrates or guesses state.
This limits damage to one record and preserves the evidence needed to diagnose it.

## Evidence

The restore gate performs six cold restarts, compares the canonical digest, checks the persistent
slot count, and requires the final sweep to forget zero records.
