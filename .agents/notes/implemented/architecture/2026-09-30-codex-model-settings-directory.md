# Agent Note: Address Codex models in the configurable-provider directory

Status: implemented

## Problem

The Models settings page reads one configurable-provider directory from `ctx.llm`. Codex owns separate `codex.providers` settings and agent routes, so its models cannot appear in that page merely because the agent picker knows them.

## Decision

The Codex provider declares each configured route as `codex:<provider>` in the existing configurable-provider directory, with `settingsNs: codex` and `settingsPath: [providers, <provider>]`. The prefix keeps the address separate from `llm-pi-ai` routes. A committed settings edit replaces the declaration set and announces a catalog update even if only a model list changed; plugin disposal withdraws it. This registration does not install an LLM adapter or change which agent loop owns a session.

## Alternatives considered

**Create a second Codex-only directory.** The Models page would need two independently refreshed lists for the same kind of settings address.

**Register Codex as an ordinary LLM adapter.** That would expose a Codex model route to the standard DSH loop and blur the single-driver ownership rule.

**Announce only changes to directory entries.** Editing a model list leaves those entries identical, so the picker could retain its old catalog after the settings commit.

## Consequences

The Models page discovers Codex provider settings alongside ordinary providers, while the agent picker keeps its separate driver catalog. The [Codex model editor decision](../feature/2026-09-30-codex-model-settings-editor.md) covers profile editing. Directory declaration does not register an LLM adapter or mark Codex providers active in the LLM registry. Model-only edits also emit a catalog event; each admitted gateway attempt holds its own settings snapshot. Tests cover settings updates, picker refresh, attempt isolation, disposal, and real Codex composition.
