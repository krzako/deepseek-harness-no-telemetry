# Agent Note: Remove web search from the harness

Status: implemented

English | [中文](2026-09-16-remove-web-search.zh.md)

## Problem

The shipped harness still offered a web-search tool and a DeepSeek search endpoint in plugin settings after related external integrations were removed. That route could send prompts to an additional model-backed search API and added credentials, configuration, providers, UI, and tests for a capability this deployment does not need.

## Decision

The harness exposes URL retrieval through `web_fetch` only. The base bundle mounts the public HTTP fetch provider; agent presets mount the fetch tool. The web service has no search registry or search method. The search provider packages, model-facing schema, settings card, and presentation code are absent. Historical session-format validation still recognizes the old DeepSeek search event structure so stored sessions can be read.

## Alternatives considered

**Hide the settings card only.** This leaves the tool, provider, and external request path active, so it does not meet the deployment requirement.

**Disable search in shipped profiles while retaining the packages.** This leaves a second API capability and unused code in the repository. Full removal makes the supported tool set explicit.

**Remove all web access.** Direct URL retrieval is independent of search and remains useful with its public-address policy.

## Consequences

New agents cannot call `web_search`, and settings no longer offer the DeepSeek search provider. `web_fetch` remains available. Existing stored search events remain data; they do not re-enable the tool.
