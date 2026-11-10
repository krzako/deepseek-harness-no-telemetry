/** Source-launched workspace transaction with the built JSONL backend; killed at a known durable boundary. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { createDshWorkspaceImportJournal } from '../../src/workspace-recovery.ts'
import { fingerprintDshWorkspace } from '../../src/workspace-fingerprint.ts'
import { withDshNewWorkspace } from '../../src/new-workspace.ts'
import { createDshWorkspaceBackup } from '../../src/workspace-backup.ts'
import { withDshWorkspaceReplacement } from '../../src/workspace-replacement.ts'

const [root, phase, mode] = process.argv.slice(2)
const source = join(root, 'staging')
const target = join(root, 'project')
await mkdir(source)
await writeFile(join(source, 'data.txt'), 'original snapshot')
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions'), compression: 'none' })
let backup
if (mode === 'replacement') {
  await mkdir(target)
  await writeFile(join(target, 'original.txt'), 'original user workspace')
  backup = await createDshWorkspaceBackup(target, root, { targetSessionId: 'destination', importId: 'crash-import' })
}
const journal = await createDshWorkspaceImportJournal({ targetSessionId: 'destination', sourceSessionId: 'source',
  sourceDriverId: 'standard', importId: 'crash-import', targetPath: target,
  ...(backup === undefined ? {} : { backupDirectory: backup.directory }),
  expectedFingerprint: (await fingerprintDshWorkspace(source)).fingerprint })
const consume = async () => {
  if (phase !== 'intent') await journal.record('materialized')
  if (phase === 'published') {
    const transaction = await ctx.sessionPersistence.beginImport({ version: SESSION_FORMAT_VERSION,
      id: 'destination', createdAt: 1000, cwd: target, isSeeded: false,
      importLineage: { sourceSessionId: 'source', sourceDriverId: 'standard', importId: 'crash-import' } })
    await transaction.handle.append([
      { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    await transaction.publish(() => true)
  }
  process.stdout.write(JSON.stringify({ journalPath: journal.path }) + '\n')
  setInterval(() => {}, 1000)
  await new Promise(() => {})
}
if (backup === undefined) await withDshNewWorkspace(source, target, consume)
else await withDshWorkspaceReplacement(source, backup, consume)
