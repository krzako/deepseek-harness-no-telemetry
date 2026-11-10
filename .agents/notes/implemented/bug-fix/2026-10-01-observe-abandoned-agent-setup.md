# Agent Note: Observe abandoned agent setup promises

Status: implemented

## Problem

An owner can abort agent creation after an asynchronous operation has started but before the abort-race helper begins observing it. The helper reports the intended abort, yet the operation's later rejection has no handler. Lifecycle tests then pass their assertions but fail on an unhandled rejection.

## Decision

The abort-race helper takes ownership of the supplied operation promise before checking the signal. If the signal is already aborted, it attaches a rejection observer to that operation and throws the abort reason. Otherwise the race observes both the operation and abort promise as before. This preserves the public cancellation result and the existing rollback and quiescence boundaries.

## Alternatives considered

**Suppress unhandled rejections in lifecycle tests.** Rejected: that hides a real orphaned promise in production.

**Defer the operation until after the abort check.** Rejected for this helper: callers already pass started operations, and changing their invocation timing would alter setup and publication ordering. A separate lazy helper remains appropriate where callers can defer work.

## Consequences

Owner and factory teardown races settle without unhandled rejections. The full agent-loop test suite exercises these races. A pre-aborted operation may still run because the caller started it; its rejection is observed, while its value is not published.
