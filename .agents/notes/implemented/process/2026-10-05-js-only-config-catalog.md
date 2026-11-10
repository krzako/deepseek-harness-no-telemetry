# Agent Note: Classify checked-in JavaScript plugin entries in the config catalog

Status: implemented

## Problem

The config catalog scans every workspace package, but a checked-in JavaScript plugin can use `main: ./index.js` without a TypeScript `src/index.ts`. Treating that package as a missing source prevents generation and hides the plugin from the catalog.

## Decision

The generator prefers `src/index.ts`. If it is absent, it reads an existing, package-relative `.js` or `.mjs` `main` with no parent traversal and runs the same export classification on that file. A JavaScript `apply` with no config argument enters the no-config list, including its declared `inject` services. A missing or unsafe main remains a violation; a config argument without a named TypeScript declaration still fails instead of inventing a config type.

## Alternatives considered

**Exclude JavaScript packages from the scan.** That would make the generated catalog incomplete and could hide a loadable plugin without a config declaration.

**Read arbitrary `exports` paths or an external file.** The current package uses a checked-in relative `main`; broader resolution would add path and conditional-export behavior without a consumer need.

## Consequences

The catalog includes the JavaScript-only PDF export plugin and can regenerate the new portable ZIP resource-policy fields. Fixture tests cover classification and refusal of missing or escaping mains; the corpus-wide freshness check verifies the generated artifact.
