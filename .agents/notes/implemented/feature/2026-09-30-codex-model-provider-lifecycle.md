# Agent Note: Create and remove Codex model providers in Models settings

Status: implemented

## Problem

The Models page can edit configured Codex profiles but cannot create one without editing `settings.yaml`. Profile deletion also needs a revision fence: removing a credential before discovering a concurrent settings change could leave a live provider without its key.

## Decision

The custom-provider card creates pi-ai and Codex profiles through one form and writes to the selected settings namespace. A Codex provider uses its unprefixed settings key and its `codex:` route identity; the credential reference derives from the prefixed route. Endpoint and at least one validated model are required. The absent `apiFormat` selects Chat Completions, while native Responses is stored explicitly. Both creation and profile editing use revision-checked settings writes and keep credentials out of settings.

Deletion removes only a user-owned profile. It unsets that profile at the revision captured when confirmation opened, then removes its page-managed credential. A settings conflict has no credential side effect. If credential cleanup fails after the profile removal commits, the page refreshes and warns that the key remains; it does not pretend the profile still exists or retry the committed removal.

## Alternatives considered

**Build a second Codex creation form.** It would duplicate route validation, model-row editing, credential handling, and revision logic while writing the same profile shape.

**Delete the credential before the profile.** A conflicting profile write could leave an active route without its credential. Ordering the settings write first instead permits an orphaned key, which the page reports explicitly.

## Consequences

Users can create, edit, and remove Codex providers without switching to YAML. Codex and standard provider IDs may share an unprefixed name because their route identities and settings namespaces differ. A failed credential cleanup requires manual removal of the retained key. Focused client tests cover defaults, Responses, model validation, duplicate IDs, stale revisions, deletion order, and the cleanup warning.
