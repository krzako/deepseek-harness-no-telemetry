# Agent Note: Edit Codex model profiles in Models settings

Status: implemented

## Problem

Codex routes appear in the configurable-provider directory, but the Models editor recognizes only DeepSeek and pi-ai namespaces. A Codex row therefore cannot edit its provider profile or credential through the GUI.

## Decision

The shared editor recognizes the `codex` settings namespace and addresses the configured provider under `codex.providers`. It edits the display name, base URL, model rows, and optional API format. The absent format means Chat Completions; an explicit `responses` selects native Responses. Credentials remain write-only: a newly entered key goes through `credentials.set`, and the profile records its reference. The provider ID remains the settings key, so editing does not rename it.

The settings schema reader traverses intersections because the Codex profile composes the pi-ai fields with `apiFormat`. The Codex model list has manual editing but hides endpoint discovery: Codex does not register an LLM discovery adapter. Profile writes use revision-checked path operations, preserving fields the card does not expose.

## Alternatives considered

**Duplicate the Models editor for Codex.** It would create a second set of credential, model-list, validation, and conflict behavior for the same profile shape.

**Present a model-discovery button without a Codex discovery adapter.** The button would consistently fail even when manual model configuration works.

## Consequences

Users can edit Codex providers alongside standard providers without placing API keys in `settings.yaml`. The [provider lifecycle decision](2026-09-30-codex-model-provider-lifecycle.md) covers creation and removal through the same Models page. The LLM directory still reports Codex routes as inactive because they are agent routes, not ordinary LLM adapters. Focused client tests cover optional format selection, credential reference writes, model edits, field preservation, and intersection schema traversal.
