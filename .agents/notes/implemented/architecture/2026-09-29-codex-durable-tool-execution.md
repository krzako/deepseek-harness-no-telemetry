# Agent Note: Execute Codex tools through durable DSH audit

Status: implemented

## Problem

Codex advertises DSH tools, but admission alone cannot perform their work. The DSH session must observe the intent before any side effect and the outcome before Codex sees it. Policy, approval, guards, and timeout handling must remain in the one DSH tool runtime rather than a second agent loop.

## Decision

After validating and binding an `item/tool/call`, append `tool/call` with the stable DSH call ID and flush the session. Only then invoke `ctx.tools.execute` with the owning agent and turn cancellation signal. Convert its materialized result into the canonical DSH tool-result message, append `tool/result` linked to the call, and flush again. Map the committed text result to the app-server reply. An append or flush failure aborts the turn and blocks further model attempts. A duplicate call cannot execute twice. The app-server supplies parsed arguments rather than the original argument bytes; the exact model request remains in `codex/model-audit`, while `tool/call` records normalized JSON.

## Alternatives considered

**Execute first and audit afterward.** A storage failure would leave an unrecorded side effect and an unexportable session.

**Dispatch the tool through the standard agent loop.** That would create a second decision loop and diverge from Codex's chosen tool call.

## Consequences

Text tool calls now use the DSH execution pipeline and return exactly the persisted result. Unit tests prove flush ordering and fail-closed behavior; a real fork app-server test proves the tool result reaches the following model request. Multimodal results and idempotent replay after reconnect remain in N023.
