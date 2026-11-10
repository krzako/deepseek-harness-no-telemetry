# AGENTS.md — Archived Agent Notes

Archived Agent Notes under the kind directories are frozen historical snapshots, not current authority. Never edit, reformat, repair, delete, or move a sealed note; use an active Agent Note or current documentation for new decisions and facts.

The archival change may only relocate the Markdown note, insert an `Archived: YYYY-MM-DD` line below `Status: implemented`, and repair or delete inbound links. Do not inspect, verify, or repair links out of archived notes.

Run the [`dsh-archive-agent-notes`](../../skills/dsh-archive-agent-notes/SKILL.md) workflow and append new artifact hashes with `pnpm run verify-archived-agent-notes --write`. The normal verifier rejects changed or missing sealed notes, unknown kind folders, and invalid archive metadata.
