# Agent Note: Codex import publication through the shared Agent factory

Status: implemented

## Problem

A validated portable Codex bundle and a typed app-server checkpoint start do not create a DSH Session. Starting a thread outside the Agent factory would expose a partially imported Session or lose its ancestry when thread startup fails.

## Decision

The Codex provider registers the shared source and target transfer ports while the attachment store is available. The source flushes a live Session or restores a detached read-only Session before it projects the verified canonical bundle. The target returns frozen preparation after checking the destination model and fork revision; it does not start a process.

`createCodexImportedAgent()` sends a same-driver V2 checkpoint through unpublished Agent setup. The Codex driver uses `thread/start` with that checkpoint only on the imported Session's fresh startup. The shared factory persists driver selection, starts the thread, records the new thread binding, and publishes the Session and Agent only after startup succeeds. Import lineage is stored in the new Session header. Historical model and tool actions are not replayed.

The provider passes its configured `runtimeRevision` to the fork as `DSH_CODEX_REVISION`. The fork records that value in each V2 checkpoint, so the target port's revision check compares the emitted revision with the declared runtime rather than an unrelated package-version fallback.

## Alternatives considered

**Start the thread in the target port.** Transfer preview and commit would create an external runtime before the shared Session lifecycle owned it, making failure cleanup and publication ordering ambiguous.

**Seed only the transcript.** The effective private Codex history and compaction state would be lost even for a same-driver transfer with a compatible checkpoint.

## Consequences

The destination requires a compatible V2 private checkpoint; a transfer from another driver needs a separate canonical-context installer. A successful import still depends on the new fork thread's state for ordinary resume; reconstructing that imported thread after deleting its own `CODEX_HOME` requires a durable destination checkpoint path. Focused tests cover the fresh checkpoint start, lineage, failed-start rollback, port registration and disposal. The opt-in real-process test compares the next model-visible request after transfer and checks resume against the new thread; it requires a fork CLI binary with durable thread-store support.

## Interrupted import recovery

JSONL inspection returns raw-file receipts and an unknown outcome without repairing logs or inferring success from a complete-looking tail. Recovery reacquires the kernel lease and compares the current inventory revision; a stalled live owner cannot be displaced by elapsed time. Nonempty imports are retained, hidden and reserved for audit review. Continuation requires a new archive import to a new ID after uncertain external effects have been resolved. Only a reservation containing the exact pending marker and no other data can be discarded. The marker is moved durably before deletion, and the stable lock inode remains. An interrupted cleanup may leave a discarded marker, but cannot expose a partial log or remove audit bytes. The host maintenance API requires existing authority over the configured root; it grants no remote access or import permission.
