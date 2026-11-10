# Agent Note: Preserve the Chat Completions semantic boundary

Status: implemented

## Problem

The initial Responses-to-Chat bridge relied on pi-ai's provider-neutral message context. That context projects in-history system messages into user messages, cannot preserve a separate developer role, and does not carry all Responses tool-choice and strict-schema fields. The bridge also ignored unsupported hosted tools and reasoning-history items. Such a request could run with a different prompt or tool contract than Codex intended.

## Decision

Keep pi-ai for provider resolution and streamed Chat response parsing, but replace its outbound Chat request's semantic fields with a checked translation of the original Codex request before DSH audits and dispatches it. Preserve text roles and order, instructions, contiguous function calls as one assistant message, function outputs, tool schemas, tool choice, and `parallel_tool_calls`. Unknown input blocks and hosted tools fail explicitly. The Codex process disables its native `web_search` advertisement until all tools are DSH-owned. Convert streamed Chat text and tool deltas into Responses events, preserve usage, distinguish failed and max-token-incomplete responses, and keep reasoning output separate from visible text.

## Alternatives considered

**Continue using only the provider-neutral context.** It cannot preserve all Chat roles and settings, so a seemingly successful request could mean something different to the model.

**Silently remove hosted tools or reasoning history.** The resulting prompt would differ from Codex's intent and would be unauditable as a faithful execution.

**Replace pi-ai's transport and stream parser.** That would duplicate the existing model-profile and provider-compatibility code for the two currently supported API formats.

## Consequences

DSH audits the actual translated request body after the semantic replacement. Codex's model call fails clearly when a Responses construct cannot be expressed by Chat Completions; supported fields are not dropped. Tests cover role order, strict tools, parallel tool-call deltas and results, usage, upstream errors, and length stops. The real fork test confirms ordinary inference and compaction still work after disabling its built-in web search. The [OpenAI function-calling guide](https://developers.openai.com/api/docs/guides/function-calling) and [streaming guide](https://developers.openai.com/api/docs/guides/streaming-responses) describe the corresponding tool deltas and terminal event families.
