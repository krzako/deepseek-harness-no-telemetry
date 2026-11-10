# Agent Note: Codex checkpoint history mode

Status: implemented

## Problem

The fork app-server defaults new persistent threads to paginated history. Its thread store rejects a complete `load_history` read for that mode, while required DSH checkpoints need the full durable rollout. The first completed model response therefore cannot produce an acknowledged checkpoint.

## Decision

The DSH client explicitly requests `historyMode: legacy` for both ordinary thread creation and checkpoint import. Resume uses the thread's persisted mode. The checkpoint reader and its fail-closed behavior remain intact.

## Alternatives considered

**Keep the app-server default.** Paginated history cannot satisfy the current complete-rollout checkpoint read. Reading only the latest model window would discard historical provenance needed by export and compaction validation.

**Change the fork-wide default.** The history requirement belongs to the DSH client; unrelated clients can retain paginated history.

## Consequences

New DSH threads retain the rollout required by portable checkpoints. Existing paginated threads are not converted or silently downgraded. Client protocol tests cover both start paths, and the opt-in real-process test verifies that completed turns reach checkpoint acknowledgment.
