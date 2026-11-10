/** Source-launch the backup owner; the parent inspects its durable output after process exit. */
import { createDshWorkspaceBackup } from '../../src/workspace-backup.ts'
const [source, parent] = process.argv.slice(2)
const backup = await createDshWorkspaceBackup(source, parent, { targetSessionId: 'new-session', importId: 'restart-import' })
process.stdout.write(JSON.stringify(backup) + '\n')
