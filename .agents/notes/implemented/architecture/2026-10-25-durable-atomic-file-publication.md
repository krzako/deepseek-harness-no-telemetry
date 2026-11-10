# Agent Note: Explicit durable atomic file publication

Status: implemented

## Problem

Workspace import recovery needs an intent record that survives process interruption before directory materialization starts. The existing atomic writer only guarantees that readers see complete replacements; it intentionally omits flush barriers. Treating its successful rename as a durable transaction record would overstate that contract.

## Decision

`writeFileAtomic` accepts explicit `durable: true` while preserving ordinary callers. Durable writes require an existing parent, flush the temporary payload, close it, and publish through the platform barrier. POSIX uses rename followed by parent-directory fsync. Windows lazily loads the repository's Koffi dependency and calls `MoveFileExW` with replace-existing and write-through, never cross-volume copy fallback. Transient Windows publication errors share the bounded replacement retry. Microsoft's [MoveFileExW contract](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) describes those flags; this does not promise storage hardware behavior beyond the platform's guarantees.

After rename, a parent-flush error reports `AtomicWriteDurabilityError` with the published path and original cause. It never deletes or restores the destination. Before publication, temporary cleanup retains the primary error and reports cleanup failure alongside it. The operation does not make missing ancestor directories durable, supply transaction recovery, or establish Windows directory ACLs.

## Alternatives considered

**Silently make every write durable.** Existing settings and credentials writes have a different contract and latency profile; their consumers must opt in deliberately.

**Use the ordinary writer as a journal barrier.** Atomic visibility alone does not satisfy a durable-intent requirement.

**Pretend a failed final flush rolled back rename.** The replacement is already visible, and deleting or replacing it would create a second unrequested mutation.

## Consequences

Workspace journaling can request a durable record without duplicating platform publication logic. Its enclosing transaction still owns sequencing, recovery and ambiguous outcomes. Tests verify flush ordering, old-target preservation before publication, visible-target reporting after publication, temporary cleanup and the native Windows flag/error contract. Native Windows and abrupt process interruption remain separate integration evidence; unit tests do not establish either.
