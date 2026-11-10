# Agent Note: One Markdown source per document

Status: implemented

## Problem

Maintaining a Chinese Markdown copy and a pairing record for every document multiplies documentation edits, generated output, validation, and agent token use. The product's user-interface locales do not require a second Markdown source tree.

## Decision

Repository documentation uses one English Markdown source per document. The documentation site can project that source into multiple route trees, but it does not generate or require translated Markdown copies. Translation-specific instructions, sidecars, hooks, and gates are removed. Client UI localization remains independent.

## Alternatives considered

**Keep synchronized translations.** This retains translated reference content but incurs a second authoring and review pass for every change, even when the user does not need it.

**Keep translation scripts without a gate.** Dormant tooling could recreate the deleted corpus or suggest an obsolete workflow, so it does not belong in the active documentation path.

## Consequences

The Chinese site route may display English source content. Historic English decision notes remain available as history, while the active documentation rules no longer request Chinese Markdown files. Git history retains deleted translations and sidecars for recovery.
