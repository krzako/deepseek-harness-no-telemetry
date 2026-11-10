# Agent Note: Isolate the fork's DSH tool router

Status: implemented

## Problem

Per-turn DSH function schemas were previously added beside Codex's native, MCP, extension, and hosted model tools. A prompt saying “use only DSH tools” cannot enforce the ownership boundary, and a recovery turn without an explicit catalog must not regain native executors.

## Decision

Mark an app-server turn with an explicit dynamic-tool override as delegated. Also pin the delegated mode for threads created by the `deepseek-harness` app-server client, including recovery turns. In that mode, construct the executable router only from dynamic function handlers, disable code mode and tool search, and provide no hosted specs. The ordinary Codex router remains unchanged for other clients pending the physical source-removal decision.

The fork adds bounded delegated-tool guidance when it assembles base model instructions for a DSH thread. That request-time composition also covers compaction and leaves persisted base instructions unchanged. DSH sends the tool catalog and executes calls, but does not inject model instructions at `thread/start`.

## Alternatives considered

**Filter only the model-visible specs.** Hidden native handlers could still be invoked through the dispatcher by a malformed or adversarial model response.

**Infer ownership from a nonempty catalog.** An empty DSH catalog or a recovery turn with no override would restore native tools.

## Consequences

The delegated model request and dispatcher share one dynamic-only registry. A real fork/DSH test checks the exact tool names sent to both Responses and Chat Completions fixtures. Another real-process test enables Codex shell configuration, injects an unadvertised `exec_command` model call, and verifies that no command side effect or DSH tool dispatch occurs. A core registry test covers enabled shell, image and code-mode features with both populated and empty delegated catalogs. Native implementation source files are still present and must be removed in N025; this step only isolates the active DSH path.
