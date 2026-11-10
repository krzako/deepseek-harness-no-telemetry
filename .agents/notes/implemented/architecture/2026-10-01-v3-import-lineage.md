# Agent Note: Import ancestry requires a new Session format generation

Status: implemented

## Problem

The in-memory Session header accepted `importLineage`, but the released-v2 physical JSONL header omitted it. A session created by agent transfer therefore lost its source session and driver when it was reopened. The released-v2 codec is frozen; extending it in place would make a new writer produce bytes that an older v2 reader could not interpret correctly.

## Decision

The current writer uses Session format v3. Its header adds optional `importLineage` containing exactly `sourceSessionId`, `sourceDriverId`, and `importId`. Validation rejects empty values, extra keys, self-reference, and coexistence with fork lineage. Event rows, provenance ranges, and inherited-cut rules retain the v2 representation.

The adjacent v2-to-v3 edge retains a frozen v2 source codec, converts complete v2 artifacts in memory, and publishes only a new immutable `session.v3.jsonl[.zstd]` successor through JSONL persistence. The source bytes and inode remain unchanged. Header-only readers classify and translate without body migration. A v2 source has no lineage to invent; its v3 header leaves that field absent.

The current v3 codec delegates event-row encoding and physical envelope validation to the frozen v2 implementation after an explicit header-only v3-to-v2 view. Installed Session restoration still owns current event vocabulary, so an ordinary new event type does not require another format bump.

## Consequences

New imports retain ancestry across disk reopen and header-only `stat` or `list`. Readers built for v2 refuse the higher generation rather than silently discarding ancestry. Existing v0, v1, and v2 files remain available beside the v3 successor. The standard Session-log ZIP serializes the same v3 ancestry field, and its log can be read by the current format catalog.

## Verification

The v3 codec tests round-trip valid ancestry and reject malformed or v2-incompatible headers. JSONL tests reopen a newly written imported session, inspect its physical header and `stat` metadata, and migrate an unchanged v2 source into a separate v3 file. The focused format and persistence suites pass.

## Alternatives considered

- **Add the field to v2 without a version bump** — an older v2 reader would reject or lose a semantically required header field.
- **Store lineage only in a Session event** — header-only readers and session routing need the ancestry without reading the event body.
