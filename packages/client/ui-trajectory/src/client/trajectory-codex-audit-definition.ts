import type { Context } from '@deepseek-ai/cordis'
import type { ConversationMatch, ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-agent-codex/types'
import { trajectoryNode } from './trajectory-definition-common.ts'

const definition: ConversationNodeDefinition<ConversationMatch> = {
  kind: 'trajectory-codex-audit',
  target: 'trajectory',
  match: event => event.type === 'codex/audit-v1'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => match,
  update: context => context.state,
  buildViewNode: (context) => {
    const event = context.state?.event
    return event?.type === 'codex/audit-v1'
      ? trajectoryNode(context, event.seq, { kind: 'codex-audit', audit: {
        seq: event.seq, time: event.time, fact: event.data,
      } })
      : null
  },
}

/** Register the Trajectory renderer for durable Codex audit facts.
 * @param ctx - client context receiving the event definition.
 */
export function registerTrajectoryCodexAuditDefinition(ctx: Context): void {
  ctx.uiConversation.events.register(definition)
}
