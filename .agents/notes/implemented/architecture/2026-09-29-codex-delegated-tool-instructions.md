# Agent Note: Tell Codex that DSH owns its tool surface

Status: implemented

## Problem

Codex's base instructions and examples can imply that native shell, patch, MCP, web, or delegation capabilities are available. DSH instead supplies the active function catalog for each turn and must execute all model-requested tools. The model needs that ownership contract without losing Codex's own reasoning and compaction guidance.

## Decision

Send bounded, persistent `developerInstructions` on DSH's `thread/start`. They identify DSH as the sole tool executor, restrict tool choice to the current request's advertised function schemas, and require an honest limitation when no matching function exists. Do not send the instructions again on `thread/resume`; Codex retains the thread's developer context. Keep the base model instructions and compaction prompt intact. The following fork step removes native tool schemas and execution paths.

## Alternatives considered

**Replace Codex's base instructions.** This would discard useful Codex behavior and could alter compaction semantics.

**Repeat an instruction in every user turn.** That would pollute user history, affect prompt caching, and make export/import less clear.

## Consequences

The delegated-tool contract appears in both the first and subsequent model requests in real-fork integration tests. It does not itself disable native tools; the fork tool-plan work must enforce the same restriction structurally.
