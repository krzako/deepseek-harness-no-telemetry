# Agent Note: Gate Codex image input on declared model capability

Status: implemented

## Problem

The Codex gateway advertised every configured model as text-only and rejected `input_image` even when a model declared image input. Simply forwarding image parts to any Chat provider would be equally unsafe: a text-only model could fail mid-turn, while an unsupported file identifier or content block could be silently dropped or mangled.

## Decision

Derive the Codex catalog's text/image capabilities from the resolved `codex.providers` model declaration. At each model attempt, reject image input if that selected model does not declare it. For Chat Completions, translate ordered Responses text and image parts into Chat text and `image_url` parts, preserving image URL and detail; accept HTTP(S) or base64 data URLs, but not a Responses `file_id`. The pi-ai context used to drive the response parser carries an image placeholder only internally; the gateway replaces its outbound message array before durable audit and dispatch, so the upstream receives the exact translated image part, not the placeholder. Native Responses forwards the original image-bearing request after the capability check. Unknown Chat modalities fail explicitly.

## Alternatives considered

**Declare every Codex model vision-capable.** This would let image requests reach endpoints whose settings do not claim image support.

**Read or download image URLs into DSH attachments first.** That would mutate the prompt and add a separate network/file boundary; the Chat API already accepts URLs and data URLs directly.

**Pass a Responses file ID through Chat Completions.** The two APIs do not share a portable file namespace, so this would imply access that was never established.

## Consequences

Only explicitly vision-capable models appear as image-capable in the Codex selector. Text-only routes fail before upstream dispatch. Tests cover ordered text/image translation, detail, unsupported modalities and file IDs, and native Responses image passthrough. The [official OpenAI image-input guide](https://developers.openai.com/api/docs/guides/images-vision) documents the URL/data-URL and `image_url` representations used here. The separate requirement that a user attachment be visible to the Codex app-server before it forms the Responses request remains unchanged.
