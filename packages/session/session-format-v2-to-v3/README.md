---
description: "Adjacent Session-format migration that preserves released-v2 events and persists import ancestry in v3."
kind: "package-library"
---

# @deepseek-ai/dsh-session-format-v2-to-v3

## Summary

This package lets the Session catalog open a released-v2 log as a v3 Session without rewriting the v2 file. Current v3 headers persist optional `importLineage` so an imported session retains its source session, source driver, and transfer ID after restart.

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

Persistence obtains this edge through the [static catalog](../session-format-catalog/README.md); deployments do not mount it as a plugin. Its v2 source reader is frozen, while its v3 writer stores one event per row and adds only optional header ancestry. The source file remains immutable when persistence publishes the v3 generation.

No runtime invariant companion is published: codec and migration calls validate their complete input and output and retain no mutable state.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The v3 codec reuses the released-v2 event-row rules. It changes the physical header version and validates `importLineage` as exactly three nonempty strings; import ancestry cannot coexist with fork ancestry or point to the same Session. The adjacent migration preserves the decoded v2 events and inherited cut, changes only the header version, and leaves import ancestry absent. Current restoration validates event vocabulary with the installed Session package.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Released v1-to-v2 edge](../session-format-v1-to-v2/README.md) — source codec and event-row semantics.
- [JSONL persistence](../session-persistence-jsonl/README.md) — immutable generation publication.
- [Format decision](../../../.agents/notes/implemented/architecture/2026-10-01-v3-import-lineage.md) — why a new generation is required.

-----

<a id="model-experience"></a>
## Model Experience

### Imported session ancestry

#### What the model sees

No new message or tool result. The migration preserves the existing model-visible `SessionEvent` history.

#### Token effect

No direct token change.

#### KV Cache effect

No direct cache-prefix change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Whole-artifact migration** — the catalog materializes the decoded event list before publishing v3.
- **No historical ancestry reconstruction** — a v2 file has no durable import lineage to recover.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
