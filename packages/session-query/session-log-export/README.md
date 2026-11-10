---
description: "Web Session-log ZIP export: Host streaming, the authenticated download route, the Session Header action, and the /export command."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-log-export

## Summary

`dsh-session-log-export` lets the Web interface download a session's full history: a `Session log` button in the Session Header and an `/export` slash command both hand the session tree — the session, its sub-sessions, and attachments — to the browser as a ZIP download. The package owns the Host archive stream, its authenticated Fetch route, and the browser controls and feedback. The browser chooses the download destination. Setup and usage come first; implementation details follow.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when the Web bundle should let users export a session log. It requires Connection, the command registry, Session query and persistence, and attachments. Mount the plugin, then click `Session log` in the Session Header or type `/export`; the browser downloads `dsh-session-<id>.zip`.

### When to choose it

Choose it for a Web deployment that needs user-facing session export with a visible download dialog. Avoid it when a programmatic or Host-side export is needed: this package produces a browser download, not a Host path write. The logs are serialized from persistence read handles, so any mounted backend is supported.

### Composition

```yaml
- id: session-log-download
  name: '@deepseek-ai/dsh-session-log-export'
```

The Web bundle mounts the package with Connection, `dsh-commands`, `dsh-client-ui-commands`, and `dsh-client-ui-conversation`.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `compressionLevel` | `6` | DEFLATE level from 0 through 9 for each ZIP entry. |
| `maxPortableEntryBytes` | unset | Optional uncompressed-byte limit for one portable ZIP entry. |
| `maxPortableTotalUncompressedBytes` | unset | Optional uncompressed-byte limit for the complete portable ZIP, including its manifest. |
| `maxImportArchiveBytes` | unset | Maximum raw ZIP upload bytes accepted by preview. |
| `maxImportEntries` | unset | Maximum ZIP entry count, including directories and manifest. |
| `maxImportEntryBytes` | unset | Maximum bytes in one decompressed import entry. |
| `maxImportTotalUncompressedBytes` | unset | Maximum total decompressed import bytes. |

### Command contract

| Input | Result |
|---|---|
| `/export` | Records a human-command lifecycle; the submitting browser opens the plaintext warning and chooses portable or log-only ZIP before downloading |
| `/export <path>` | An error; browser downloads choose their destination through the browser's ordinary download behavior |

### What to expect

The dialog first warns that all ZIP choices are unencrypted and include full content without automatic redaction. Its primary action downloads a portable archive; the secondary action downloads a transcript-only log that cannot fully restore agent state. Both omit workspace files; a separate action explicitly includes a workspace snapshot. Closing this warning makes no network request. A fresh download requires a fresh explicit choice. After confirmation, the dialog reports preparing, download started, or failed. Closing the dialog does not cancel an in-flight download, and the dialog does not reopen when that operation later settles. One session admits one active download at a time; repeated gestures share that operation. The export includes the live session's newest events: the host endpoint flushes a live root session before reading, so a slash-triggered ZIP includes the `command/run` and `command/done` pair that started the download; a live session without a participating durability listener fails export, while cold persisted sessions need no flush. Each logical log uses the current generation's canonical filename inside the archive (`session.jsonl` for v0, otherwise `session.vN.jsonl`), including beneath each sub-session directory. Its v3 header retains `importLineage` when the session came from another agent. Images use `media/<attachmentId-without-sha256-prefix>.<ext>` while logs and context retain the original attachment id, and generic files use `files/<digest-prefix>/<digest>/<name>`. Generic-file bytes are read and compressed as bounded chunks, so exporting a large upload does not buffer it in full. Referenced Codex audit blobs are included once under `audit/<sha256>.blob` with their unredacted bytes; export requires a preceding receipt in each owning Session and fails the ZIP stream if a blob is missing or fails SHA-256/size verification. Each included Codex audit log must have continuous sequence numbers, unique event IDs, one thread identity, and no unresolved compaction checkpoint. V2 context checkpoints additionally require valid inner history/rollout digests, a matching accepted turn configuration, and installed compaction facts before export completes. Checkpoint verification streams the blob through a private temporary file and parses its arrays item by item, without buffering the complete blob.

An authorized `GET /api/session.export?sessionId=<id>&format=portable` requests a portable Session ZIP. It requires a durable source-driver selection and that driver's export port; otherwise the route returns 409 before streaming. The route rereads the durable root log after the source port returns and reports a retryable 409 if it changed. The ZIP contains the canonical context, driver state, optional private checkpoint, the Session logs and referenced attachments, and a final `manifest.json` with SHA-256 and byte count for each preceding entry. A context attachment without matching ZIP bytes fails the stream instead of producing a manifest; a named file reference must also match the ZIP entry's normalized name, while an unnamed one matches by digest. Optional operator byte limits stop the stream before an oversized chunk enters the ZIP; an incomplete download has no valid final manifest. With both limits unset, no archive-size policy is imposed. Workspace files are excluded unless `includeWorkspace=true` is explicitly selected. The ordinary button and `/export` command offer this format as their primary confirmation action. Their log-only action explicitly sends `format=log`; direct HTTP requests without a format also select portable ZIP. Missing portable context returns 409; it never silently falls back to a transcript.

`portableContextJsonStream()` is the incremental V1 encoder for a driver-supplied item stream. Resident items retain the materialized context JSON encoding. A source-validated opaque JSON stream preserves its original spelling inside an ordinary V1 opaque block; the encoder checks its size and SHA-256 at EOF. It retains ID sets for reference validation and one resident item or compaction at a time, while opaque JSON bytes pass through without materialization. `portableSessionZipEntries()` accepts either a resident or streamed bundle and checks each streamed item's attachment references against completed ZIP receipts before it can emit a final manifest. An optional source-validated private context JSON stream is wrapped in the standard checkpoint envelope; the exporter rechecks its declared length and SHA-256 at EOF before finalizing the manifest. The route prefers the source driver's optional `exportPortableContextStream()` and otherwise calls its resident export method. It acquires the source snapshot between two durable-root reads and consumes the stream only when those reads agree. The standard driver supplies a streamed canonical context; the Codex source supplies streamed context and checkpoint values; artifact prompts and results use the opaque byte-stream representation.

Portable exports fingerprint the source workspace with `dsh-workspace-content-v1`: ordered relative paths, regular-file bytes, directories (including empty ones) and symlink text, without following child links. The manifest names the algorithm or explicitly reports why no fingerprint is available. A missing former workspace does not prevent exporting conversation context. File reads are streamed and observations are checked again before success; detected changes and cancellation fail export. The scan includes hidden and ignored files, retains path/stat metadata and adds I/O proportional to workspace content, but does not copy those files into the ZIP. Permissions, owners and timestamps are excluded from content equality.

### Failures

The dialog shows a preparation error when the preflight fails before ZIP streaming starts — for example an unreachable or misconfigured host endpoint. A descendant or attachment read failure after the browser accepts the GET is reported by the browser download manager, not by the dialog.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the package wires the export control and points at the code that realizes it; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design split

The package has two halves. The Host half ([`src/index.ts`](src/index.ts)) registers the `/export` command and contributes the exact `GET`/`HEAD /api/session.export` Fetch route to Connection; [`src/archive.ts`](src/archive.ts) builds the bounded ZIP stream. The browser half ([`src/client/index.ts`](src/client/index.ts)) provides the shared download controller and UI, and observes `command/executed` so only the submitting browser starts a download.

[`src/manifest.ts`](src/manifest.ts) defines the versioned manifest and validator for portable Session archives. [`src/manifest-stream.ts`](src/manifest-stream.ts) measures ZIP entries as they are consumed and creates a manifest only from complete byte/hash receipts; interrupted or failed streams cannot supply a receipt. [`src/portable-archive.ts`](src/portable-archive.ts) adds the source driver's context and optional private checkpoint to that stream. [`src/json-stream.ts`](src/json-stream.ts) encodes those two JSON entries in bounded pieces, including long string values, without constructing a full serialized string. The browser requires a plaintext confirmation and sends the selected format explicitly; only the log-only choice omits a manifest.

`validateDshSessionZip()` validates a completed private staging file without extraction or publication. It reads the central directory with `yauzl`, admits only stored or deflated regular files and empty directories, checks local headers, measures every decompressed payload, verifies CRC32 and sizes, and compares SHA-256 receipts with the manifest. Duplicate, traversal, conflicting, encrypted and link-shaped entries fail. Optional byte and entry-count limits apply during validation, including the manifest; absent limits impose no fixed archive ceiling. Cancellation and failures close the readers; the caller owns staging-file deletion. Memory retains the manifest and path/receipt sets. This container check does not validate session/context semantics, authorize an import or create a session.

Legacy and log-only ZIPs without `manifest.json` are refused with `DshArchiveManifestRequiredError` (`DSH_ARCHIVE_MANIFEST_REQUIRED`) after ZIP integrity checks. They remain readable as transcripts outside the importer; no canonical context is inferred and no faithful restoration is claimed. The source instance must produce a portable export. Invalid manifests and unsafe ZIP entries retain their validation errors. A valid portable archive may omit a private checkpoint; its target capabilities determine fidelity instead of treating it as legacy.

`readDshSessionZipPayloads()` reads requested manifest payloads for resident preview. It revalidates every ZIP entry, then compares the complete manifest with the prior validation result before returning any bytes. A changed unselected entry, coherently replaced archive, invalid selection, limit overrun or cancellation rejects the operation. Only selected payloads are buffered in addition to the manifest and receipt sets; attachments need not enter preview memory. The caller owns the private staging file and its deletion.

`readDshSessionArchiveLogs()` rereads the manifest-declared logs through the verified payload reader and the caller's installed Session format catalog. It rejects incomplete JSONL, malformed UTF-8, invalid events, duplicate identities, unrelated descendants, inconsistent depths and root/workspace disagreement. Historical formats migrate only in memory; each result retains its stored version alongside the current artifact. An exported subtree may have an external root parent. No persistent session, thread or workspace is created. The logs remain resident; canonical-context agreement, attachment references and target-agent requirements are outside this log check.

`readDshSessionArchiveBundle()` adds canonical V1 schema validation and cross-checks to the log reader. Driver state must exactly match the context source, the root Session identity, its single durable driver choice and header import lineage. Additional driver/context/private declarations reject as ambiguous. An optional private checkpoint must have a valid shared envelope owned by the source driver; this reader does not interpret its driver-specific body. Log and metadata reads each reverify the complete ZIP against the same captured manifest. Every included log also passes the exporter's audit sequence, compaction and preceding-receipt checks; referenced audit blobs must match manifest attachment paths, hashes and sizes. Each logged V2 checkpoint also passes the existing Codex verifier for inner history/rollout digests, accepted configuration and installed compaction. Its resolver reads only artifacts referenced by that log, reverifies the ZIP for each read and buffers one complete artifact per read; repeated checkpoint reads may scan the archive repeatedly. Ordinary attachment references from all logs and canonical items, including nested tool results, must match attachment entries; log byte counts and content-addressed hashes are checked. Conflicting byte/image metadata rejects before deduplication. This checks references and bytes, not image decoding or intrinsic dimensions against encoded pixels. Full log/context projection agreement, agreement of the private bundle with audited checkpoints, target capabilities and credentials still require validation before import.

`verifyDshSessionArchiveProjection()` verifies the ZIP again, restores a detached root Session and invokes the registered source driver's `exportArchivedContext()` through the shared bundle comparator. Artifact requests can read only declared attachment bytes with the requested hash and size, with ZIP revalidation on each read. The entire projected bundle must equal the archived bundle, including private checkpoint state. The operation has no target driver or persistent Session, and does not use the old runtime home. It must follow bundle validation; destination capabilities and credentials are still separate preview requirements.

`previewDshSessionArchive()` composes ZIP, bundle and source projection validation before reading the destination’s shared import capabilities. It returns model/context compatibility issues, including unsupported choices, without invoking destination import or creating persistent state. Corrupt source data rejects before consulting the destination. It then reads the target’s authentication metadata for an available model. Missing references are requirements for a later model call; provider-managed and unverified states require separate authentication verification. Inspection failure or cancellation rejects the preview. No key values are returned. Workspace inspection reports presence and choices separately; compatible context or configured key presence is not authorization or proof that a model request will succeed. The caller owns private staging and cleanup.

`previewDshWorkspaceImport()` reads an authorized absolute destination without creating or modifying files. The combined preview includes this observation. Existing directories offer keeping their files; an available snapshot also offers application, with separate confirmation and recoverable backup required for an existing destination. A missing destination with a snapshot offers creation from that snapshot; without a snapshot it offers context-only import with a workspace required before the next workspace-dependent turn. A snapshot with no selected destination requires choosing one first. File targets, dangling links and access failures reject; existing directory aliases are canonicalized. For a recognized source fingerprint algorithm, the preview computes the target content fingerprint and reports matching-content or different-content. Legacy digests without an algorithm remain unverified. Matching content does not verify permissions, ownership or other environment state, so keeping files does not claim full environment fidelity. Snapshot-content fidelity is conditional on later successful application and does not promise preserved filesystem metadata. The import transaction must recheck every observation before writing.

`compareDshWorkspaceSnapshot()` adds typed file and directory comparisons to the combined preview as `workspaceEntries`: new, identical file, changed file, directory present, destination type conflict or parent conflict. Declared empty directories participate; `directory-present` means matching type only, not matching contents. Legacy snapshots without a directory inventory still compare only their files. Regular files are read sequentially and compared by byte count and SHA-256; links are conflicts rather than read targets. File handles close on success, failure and cancellation, and detected concurrent changes reject. An absent snapshot returns null; an empty snapshot returns an empty list. The comparison covers declared snapshot entries only, not extra destination files or filesystem metadata, so even identical results do not establish whole-workspace fidelity. This is an observation of an authorized workspace, not a filesystem sandbox or a write reservation; the later import transaction must recheck it before application and backup.

`withDshWorkspaceSnapshot()` streams snapshot files into a fresh private staging directory under an authorized parent. It creates files exclusively with owner-only permissions, including empty files, and calls its consumer only after the entire ZIP and captured preview manifest have been revalidated. Limits cover non-workspace payloads too. The consumer may move completed contents as part of its own transaction; the helper removes remaining staging and closes handles on every outcome. It never writes to the destination workspace. V1 staging reconstructs declared regular-file bytes and their parent directories, plus empty directories when listed in snapshot metadata, but not source permissions; transaction durability, backup and publication remain the caller's responsibility.

Attachment deduplication checks metadata across the entire exported log tree. Conflicting image dimensions, media types or byte counts, and conflicting byte counts for the same file identity and name, fail both log-only and portable ZIP streams. Matching references still share one payload; a later descendant cannot overwrite the root's metadata silently.

Before emitting the portable manifest, the exporter flushes and rereads every included logical log, compares its SHA-256 with the exported bytes, and checks the descendant inventory again. A changed or missing log, failed flush or changed descendant set fails the ZIP stream. This retains digests and rereads one log at a time rather than holding the whole tree in memory. The root context is also checked against the durable read before streaming; source ports preserve their own captured-context checks. The completed archive represents the verified read, not future changes after that check.

`verifyDshArchiveInventory` compares a parsed manifest with the complete inventory of measured uncompressed payloads, excluding `manifest.json`. It rejects missing, extra, duplicate, or changed payloads; receipts must come from consumed bytes rather than ZIP headers. It does not parse ZIP containers, enforce decompression limits, or validate payload semantics, and does not authorize or publish an imported session.

### Download flow

Both entry paths issue a `HEAD` preflight to `GET /api/session.export?...`, then hand the GET URL to the browser download manager without buffering the ZIP in JavaScript. One controller owns one in-flight download per session, collapses concurrent gestures into that operation, and cancels the preflight on plugin disposal. Modal state lives in a snapshot store keyed by session, so the button and the command share one dialog per session.

The Host route is a feature-owned exact Fetch contribution. Connection applies its Host/Origin and browser-session checks and bridges the streaming `Response`; this package owns query validation, live-session flushes, handle-based log reads and attachment reads, ZIP generation, and HTTP status semantics.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the Web control to the host endpoint and the surrounding command and session surfaces.

- [dsh-client-connection](../../client/connection/README.md) — the authenticated Fetch-route carrier used by the Host endpoint.
- [Commands subsystem reference](../../../docs/subsystems/commands.md) — the human-command registry the `/export` command registers on.
- [dsh-client-ui-commands](../../client/ui-commands/README.md) — the browser command surface that renders and acknowledges `/export`.
- [Session Query package map](../README.md) — the retrieval family this package belongs to.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/export` control

#### What the model sees

Nothing. `/export` stays on the human-command plane, and the ZIP download does not enter model history.

#### Token effect

Zero. The command creates no model turn.

#### KV Cache effect

None. The log-only command lifecycle and browser download do not change the derived request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **Browser download, not a Host-path writer** — the browser chooses the local destination; no Host path or native folder action is returned.
- **Preflight reports only pre-stream failures** — a descendant or attachment failure after the browser accepts the GET is reported by the browser download manager, not by the dialog.
- **Portable source memory** — the current source port returns a resident canonical bundle; streamed ZIP encoding does not bound memory used to construct that bundle.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked pages.

#### Future: export destinations beyond the browser

The download is deliberately browser-scoped; a Host-path or native folder export would need a new endpoint contract and a decision on where the ZIP lands.

</details>

**Runtime invariant:** No companion is published. Connection and the command registry own both registrations, while each export reads authoritative Session services.

The authenticated `POST /api/session.import.preview?driverId=<driver>&provider=<provider>&model=<model>` accepts raw `application/zip` bytes. Optional `workspace` is an authorized absolute destination for read-only inspection. Uploads stream to a private, exclusive temporary file; all staging is removed after success, validation failure or cancellation. The response reports source identity, log generations, destination compatibility, local authentication readiness and workspace choices. It creates no Session or thread, replays no effects and grants no reusable import token. A later import must reupload and revalidate. Unsupported or malformed archives return 422; log-only ZIPs carry `DSH_ARCHIVE_MANIFEST_REQUIRED`, and a compressed upload exceeding operator policy returns 413. No raw exception or host diagnostic is returned. Encrypted uploads, persistent staging and import confirmation are not implemented by this route. The preview's existing resident log/context costs still apply after streaming intake.

`withDshArchiveAttachments` streams attachment payloads into exclusive private files and supplies an archive-path-to-file map only after revalidating every ZIP entry against the captured manifest. Empty attachments are preserved. It shares staging and cleanup with workspace extraction, applies operator limits to the whole archive, and removes partial or completed staging on failure, cancellation and success. The consumer owns store publication and cancellation after entry; it must not retain the paths. No Session, audit store or workspace is published by this helper. Inventories remain resident; payload writes use bounded chunks and backpressure. Archive attachment restoration and the encompassing import transaction remain separate work.

`restoreDshArchiveAttachments` restores logged images through exact `restoreImage` and streams generic files and referenced audit blobs through `saveFileStream` in 64 KiB chunks. It validates references and revalidates the entire archive before store calls, rejects changed provider references, and cleans staging and open handles on failure. One encoded image is resident at a time. Cancellation stops subsequent objects; already durable shared objects remain after partial failure and must not be deleted by import rollback. This helper does not publish historical events or Sessions and does not resolve canonical-only references or complete the enclosing workspace/import transaction.

Resolved transfer attachments use `portableAttachmentKey` (id, media type, optional name), not digest alone. This preserves identical bytes used as an image and a file or with several explicit filenames without overwriting references; the canonical archive format is unchanged. Archive resolution uses validated logged metadata, canonical image display names, and exactly one matching file reference. Missing metadata or an unnamed file with several candidates rejects explicitly. Resolution only prepares detached references; attachment restoration must finish before Session publication.

`prepareDshSessionArchiveImport` validates a private ZIP and its source projection, resolves canonical attachments, and returns a detached review with a fresh target ID and one publication attempt. Explicit `keep-workspace` retains an existing directory; `apply-snapshot` can materialize an archived snapshot into a previously absent directory beneath an existing parent. Existing workspace replacement requires separate confirmation at commit; context-only import still rejects. Commit requires acknowledgment of context and workspace warnings, revalidates the ZIP, restores attachments, rechecks the selected model and workspace observation, then publishes through the registered driver. Replaced directories and changed recognized content fingerprints require another review. Local credential metadata is reported without remote verification. Commit returns `{ handle, workspaceBackup, stagingCleanup }`: the caller owns the published Agent handle, while null stagingCleanup confirms cleanup and a non-null value identifies retained private staging and its error. Repeated commits return the same result. The caller owns archive staging; the driver publisher owns Session rollback, while already durable shared attachment objects survive failures. Unsupported workspace actions reject before attachment writes. There is no publication HTTP route or permission grant in this helper. Workspace observations do not lock files against subsequent external edits, and legacy or unavailable fingerprints retain unverified fidelity.

Snapshot metadata may include `directories`, the complete list of archive paths below its prefix; the root is implicit. Paths must be safe and unique, every parent must be listed, and no directory may collide with a payload file. Staging creates this directory structure only after complete ZIP validation and checks a recognized workspace fingerprint before entering the consumer. A mismatch rejects and removes staging. Older snapshots without the list remain readable, reconstruct only file parents, and report `snapshot-directories-unrecorded` with unverified application fidelity. A recorded list permits conditional snapshot-content fidelity; source permissions and other environment metadata remain outside that claim. Destination workspace replacement remains separate from snapshot staging.

`includeWorkspace=true` explicitly adds a complete workspace snapshot to portable HTTP downloads; absent or false keeps the default without files, and log-only requests cannot opt in. The browser offers a separate unencrypted workspace ZIP button after warning that hidden files and secrets are included. The root comes only from the source Session header. Capture inventories every regular file and directory, including empty directories, with no ignore rules. Symlinks, special objects, unreadable trees and nonportable archive paths reject instead of being omitted. File reads use bounded chunks and the existing operator byte budgets. Identity observations and a content fingerprint are checked again before the final manifest; detected changes fail the download. This is a consistency check on an authorized workspace, not a filesystem lock or protection against hostile concurrent path replacement. Snapshot metadata and file inventories remain resident; file contents do not.

Applying a snapshot into a new workspace revalidates the ZIP into private staging before reserving the destination with exclusive mkdir. Each file is created exclusively and copied in bounded chunks; directories, including empty ones, are retained. The complete content fingerprint is compared before publishing the new Session through the target port. Ordinary errors and cancellation remove only owned paths whose remaining bytes still match the staged source, including partial copied prefixes. Changed identity, foreign paths or edited bytes refuse rollback with an AggregateError reporting outcome unknown and preserve the workspace for inspection. Private archive staging still cleans up, while already durable shared attachments remain. This check assumes a cooperative local filesystem and does not lock out external edits. Process death can leave a partial directory; the durable journal supports inspection and retention as described below. Snapshot permissions and ownership are not restored.

Before workspace creation, the coordinator durably records intent in `.dsh-workspace-import-<session-id-hash>.json` beside the destination. The record binds the destination, source, import ID and expected fingerprint; materialization records directory identity before Session publication. `inspectDshWorkspaceImport` reads an authorized canonical journal and authoritative Session metadata. Matching published lineage proves publication even if the process died before returning; absent or mismatched metadata leaves outcome unknown unless a recorded rollback has no remaining destination. Workspace identity and fingerprint are reported separately from publication, since later edits do not undo a published Session. Unknown attempts may still have live owners.

`retainDshWorkspaceImport` repeats the reviewed observation, refuses changes, and preserves every byte without replay, deletion or resume. These helpers grant no filesystem permission and do not automatically repair partial trees. Invalid journals and persistence access errors reject inspection. Files are flushed before publication; POSIX also flushes created directories and the parent. Journal publication uses the shared durable atomic writer, including Windows write-through. Process-crash tests do not establish power-loss guarantees for a Windows workspace tree. A staging-cleanup error after successful Session publication is a separate result field; it never rolls back the Session or workspace. Before publication, simultaneous import and cleanup failures preserve both causes in an AggregateError. Cleanup paths require authorized inspection and may contain sensitive archive bytes.

The internal workspace-backup helper prepares a content copy before existing-workspace replacement. Its private directory must be outside the source tree. A durable manifest binds the target Session and import ID to the source identity and content fingerprint; only a verified ready record is usable. All ordinary files, hidden files and empty directories are copied in bounded chunks, without ignore rules. Child links and special objects reject. Source changes during copying prevent readiness. Inspection verifies the copied tree after restart without reading the source, and rejects changed backup contents. Failed preparation retains its private directory and exposes its location for inspection; copying or malformed records never authorize replacement. The replacement coordinator consumes this backup before changing the existing tree. Permissions, ownership and ACLs are outside its content fidelity, and native Windows power-loss durability remains unverified.

Workspace replacement uses an internal exclusive-move primitive rather than checking absence before ordinary rename. Linux uses renameat2 with RENAME_NOREPLACE, macOS uses renamex_np with RENAME_EXCL, and Windows uses MoveFileExW with WRITE_THROUGH alone. Existing destinations, cross-volume moves and unsupported primitives reject without a copy/delete fallback. POSIX flushes both parent directories after success; failure then reports moved=true and leaves the destination for transaction recovery. Callers must flush payloads, journal intent and inspect uncertain I/O outcomes themselves. The primitive protects the destination from replacement, not ancestor/source races on a hostile filesystem. Linux has native execution coverage; Windows/macOS bindings have simulated flag/error coverage and require native platform validation.

For an existing workspace, `replacesExistingWorkspace` identifies whole-tree replacement, including files absent from the snapshot. `commit(true, true)` separately acknowledges preview warnings and this replacement; omitting the second acceptance rejects before attachment or workspace writes. The coordinator revalidates the reviewed source, creates a verified backup beside it, then journals that backup location before materializing the replacement. Exclusive moves retain the original tree at backup/original and install the snapshot without overwriting a competing path. Successful publication returns workspaceBackup; the original tree retains its filesystem metadata, while backup/workspace remains the independent content copy. Neither is automatically deleted.

Ordinary publication failure restores the original tree only if the installed replacement still has the expected identity and content and the destination is available. Changed replacement files or competing paths prevent rollback and remain alongside the original in outcome unknown. Source edits detected before or during displacement prevent publication; existing data is retained. Recovery reads the backup binding from the import journal, verifies its Session/import identity and reports original-tree content independently. A recorded rollback counts as restored only when the target identity and content match the original backup record. Preexisting journals without a backup binding keep their new-workspace semantics. Replacement does not lock out writes through already-open descriptors or hostile ancestor changes; unknown outcomes require inspection.

Portable, log-only and workspace downloads (GET/HEAD) and raw ZIP preview (POST) inherit [Connection browser authentication and request trust](../../client/connection/README.md#browser-authentication-and-request-trust) before their handlers run. Missing or invalid owner cookies receive 401; rejected Host/Origin or cross-site markers receive 403, including malformed upload requests. The successful cookie identifies the owner of this instance; these routes do not implement per-Session multi-user ACLs. Preview grants no publication permission or import token. This scope does not establish authorization for a future import-commit endpoint or password handling.
