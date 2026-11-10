/** Versioned, provider-neutral state for transferring one Agent Session. */

import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Immutable full-agent choice committed before the first turn. */
    'agent/driver-selected': { readonly version: 1; readonly driverId: string }
  }
}

/** Serialized state and context format; changing a field requires a new reader version. */
export const PORTABLE_AGENT_VERSION = 1 as const

/** The driver selection persisted independently of the selected model route. */
export interface AgentDriverStateV1 {
  readonly version: typeof PORTABLE_AGENT_VERSION
  readonly sessionId: string
  readonly driver: { readonly id: string; readonly version: string }
  readonly model: { readonly provider: string; readonly id: string }
  readonly lineage?: {
    readonly sourceSessionId: string
    readonly sourceDriverId: string
    readonly importId: string
  }
}

/** Content that another driver can inspect without interpreting a Codex rollout. */
export type PortableContentBlockV1 =
  | { readonly kind: 'text' | 'reasoning' | 'refusal'; readonly text: string }
  | { readonly kind: 'attachment'; readonly attachmentId: string; readonly mediaType: string; readonly name?: string }
  | { readonly kind: 'tool-call'; readonly callId: string; readonly name: string; readonly arguments: string }
  | { readonly kind: 'tool-result'; readonly callId: string; readonly content: readonly PortableContentBlockV1[]; readonly isError: boolean }
  | { readonly kind: 'opaque'; readonly namespace: string; readonly value: JsonValue }

/** Key a resolved attachment by its full canonical identity, without delimiter collisions.
 * Digest alone cannot distinguish an image from a file or different display names.
 * This is an in-memory transfer key, not a new archive format or stored object id.
 * @param attachment - canonical attachment identity to resolve.
 * @returns stable map key including the distinction between absent and empty names.
 */
export function portableAttachmentKey(
  attachment: Pick<Extract<PortableContentBlockV1, { kind: 'attachment' }>, 'attachmentId' | 'mediaType' | 'name'>,
): string {
  return JSON.stringify([attachment.attachmentId, attachment.mediaType, attachment.name ?? null])
}

/** A source item retained even when compaction removes it from the effective prompt. */
export interface PortableContextItemV1 {
  readonly id: string
  readonly role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  readonly content: readonly PortableContentBlockV1[]
  readonly provenance: { readonly kind: 'user' | 'model' | 'tool' | 'instruction' | 'compaction'; readonly sourceId?: string }
}

/** The installed context after one local or model-driven replacement. */
export interface PortableCompactionV1 {
  readonly id: string
  readonly mode: 'local' | 'remote'
  readonly inputItemIds: readonly string[]
  readonly outputItemIds: readonly string[]
  readonly promptItemIds: readonly string[]
  readonly resultItemIds: readonly string[]
}

/** Complete portable history and its ordered model-visible active projection. */
export interface PortableAgentContextV1 {
  readonly version: typeof PORTABLE_AGENT_VERSION
  readonly source: AgentDriverStateV1
  readonly items: readonly PortableContextItemV1[]
  readonly effectiveItemIds: readonly string[]
  readonly compactions: readonly PortableCompactionV1[]
}

/** Transport-only opaque item; the archive still contains an ordinary V1 opaque block.
 * The source must validate exactly one lossless JSON value before supplying this
 * stream. Consumers verify bytes and SHA-256 at EOF, not JSON semantics. These
 * opaque values contain no canonical attachment blocks or item references.
 */
export interface PortableOpaqueContextItemStreamV1 {
  readonly encoding: 'opaque-json'
  readonly id: string
  readonly role: PortableContextItemV1['role']
  readonly namespace: string
  readonly provenance: PortableContextItemV1['provenance']
  readonly json: {
    readonly chunks: AsyncIterable<Uint8Array>
    readonly bytes: number
    readonly sha256: string
  }
}

/** Single-consumption source for a V1 context whose large arrays need not coexist in memory. */
export interface PortableAgentContextStreamV1 {
  readonly version: typeof PORTABLE_AGENT_VERSION
  readonly source: AgentDriverStateV1
  readonly items: AsyncIterable<PortableContextItemV1 | PortableOpaqueContextItemStreamV1>
  readonly effectiveItemIds: AsyncIterable<string>
  readonly compactions: AsyncIterable<PortableCompactionV1>
}

/** Private checkpoint, used only by the driver that owns its namespace and version. */
export interface PrivateDriverSnapshotV1 {
  readonly version: typeof PORTABLE_AGENT_VERSION
  readonly driverId: string
  readonly driverRevision: string
  readonly schemaVersion: number
  readonly context: JsonValue
}

/** Capabilities declared by a destination driver before import is committed. */
export interface PortableImportCapabilitiesV1 {
  readonly driverId: string
  readonly supportedContextVersions: readonly number[]
  readonly supportedPrivateSnapshotVersions: readonly number[]
  readonly supportedPrivateRevisions: readonly string[]
  readonly supportedOpaqueNamespaces: readonly string[]
  readonly availableModels: readonly { readonly provider: string; readonly id: string }[]
}

/** A blocking incompatibility or a choice requiring explicit user acknowledgment. */
export interface PortableImportIssueV1 {
  readonly severity: 'error' | 'warning'
  readonly code: 'context-version' | 'opaque-content' | 'private-snapshot' | 'model-unavailable' | 'model-changed' | 'driver-changed'
  readonly detail: string
}

/** Driver-neutral import assessment; warnings are never silently discarded. */
export interface PortableImportAssessmentV1 {
  readonly fidelity: 'same-driver' | 'portable' | 'unsupported'
  readonly issues: readonly PortableImportIssueV1[]
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function keys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key))
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(nonempty)
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

/**
 * Validate an untrusted persisted or imported driver selection.
 * @param value - parsed driver-state payload.
 * @returns whether it is the supported version-one state.
 */
export function isAgentDriverStateV1(value: unknown): value is AgentDriverStateV1 {
  if (!record(value) || !keys(value, ['version', 'sessionId', 'driver', 'model'], ['lineage'])
    || value.version !== PORTABLE_AGENT_VERSION || !nonempty(value.sessionId)) return false
  const { driver, model, lineage } = value
  if (!record(driver) || !keys(driver, ['id', 'version']) || !nonempty(driver.id) || !nonempty(driver.version)
    || !record(model) || !keys(model, ['provider', 'id']) || !nonempty(model.provider) || !nonempty(model.id)) return false
  return lineage === undefined || (record(lineage) && keys(lineage, ['sourceSessionId', 'sourceDriverId', 'importId'])
    && nonempty(lineage.sourceSessionId) && nonempty(lineage.sourceDriverId) && nonempty(lineage.importId))
}

function isBlock(value: unknown, depth = 0): value is PortableContentBlockV1 {
  if (!record(value) || depth > 64) return false
  switch (value.kind) {
    case 'text':
    case 'reasoning':
    case 'refusal':
      return keys(value, ['kind', 'text']) && typeof value.text === 'string'
    case 'attachment':
      return keys(value, ['kind', 'attachmentId', 'mediaType'], ['name']) && nonempty(value.attachmentId)
        && nonempty(value.mediaType) && (value.name === undefined || typeof value.name === 'string')
    case 'tool-call':
      return keys(value, ['kind', 'callId', 'name', 'arguments']) && nonempty(value.callId)
        && nonempty(value.name) && typeof value.arguments === 'string'
    case 'tool-result':
      return keys(value, ['kind', 'callId', 'content', 'isError']) && nonempty(value.callId)
        && typeof value.isError === 'boolean' && Array.isArray(value.content)
        && value.content.every(block => isBlock(block, depth + 1))
    case 'opaque':
      return keys(value, ['kind', 'namespace', 'value']) && nonempty(value.namespace) && isJsonValue(value.value)
    default:
      return false
  }
}

function isItem(value: unknown): value is PortableContextItemV1 {
  if (!record(value) || !keys(value, ['id', 'role', 'content', 'provenance'])
    || !nonempty(value.id) || typeof value.role !== 'string'
    || !['system', 'developer', 'user', 'assistant', 'tool'].includes(value.role)
    || !Array.isArray(value.content) || !value.content.every(block => isBlock(block))) return false
  const source = value.provenance
  return record(source) && keys(source, ['kind'], ['sourceId'])
    && typeof source.kind === 'string'
    && ['user', 'model', 'tool', 'instruction', 'compaction'].includes(source.kind)
    && (source.sourceId === undefined || nonempty(source.sourceId))
}

/** Validate one stream item before it enters a canonical context.
 * @param value - untrusted item yielded by a source driver.
 * @returns whether its role, content blocks, and provenance are valid V1 data.
 */
export function isPortableContextItemV1(value: unknown): value is PortableContextItemV1 {
  return isItem(value)
}

function isCompaction(value: unknown, itemIds: ReadonlySet<string>): value is PortableCompactionV1 {
  if (!record(value) || !keys(value, ['id', 'mode', 'inputItemIds', 'outputItemIds', 'promptItemIds', 'resultItemIds'])
    || !nonempty(value.id) || (value.mode !== 'local' && value.mode !== 'remote')) return false
  return ['inputItemIds', 'outputItemIds', 'promptItemIds', 'resultItemIds'].every((key) => {
    const ids = value[key]
    return stringArray(ids) && unique(ids) && ids.every(id => itemIds.has(id))
  })
}

/** Validate one compaction after all referenced item IDs have been observed.
 * @param value - untrusted compaction yielded by a source driver.
 * @param itemIds - IDs already validated from the streamed item sequence.
 * @returns whether every reference and V1 field is valid.
 */
export function isPortableCompactionV1(value: unknown, itemIds: ReadonlySet<string>): value is PortableCompactionV1 {
  return isCompaction(value, itemIds)
}

/**
 * Validate format, content, unique identities, and every effective/compaction reference.
 * @param value - parsed portable context.
 * @returns whether all version-one fields and references are valid.
 */
export function isPortableAgentContextV1(value: unknown): value is PortableAgentContextV1 {
  if (!record(value) || !keys(value, ['version', 'source', 'items', 'effectiveItemIds', 'compactions'])
    || value.version !== PORTABLE_AGENT_VERSION || !isAgentDriverStateV1(value.source)
    || !Array.isArray(value.items) || !value.items.every(isItem)
    || !stringArray(value.effectiveItemIds) || !Array.isArray(value.compactions)) return false
  const ids = value.items.map(item => item.id)
  const itemIds = new Set(ids)
  return unique(ids) && unique(value.effectiveItemIds) && value.effectiveItemIds.every(id => itemIds.has(id))
    && value.compactions.every(compaction => isCompaction(compaction, itemIds))
    && unique(value.compactions.map(compaction => compaction.id))
}

/**
 * Validate a namespaced, lossless-JSON private checkpoint without interpreting its content.
 * @param value - parsed private checkpoint envelope.
 * @returns whether its envelope is valid; the owning driver validates `context`.
 */
export function isPrivateDriverSnapshotV1(value: unknown): value is PrivateDriverSnapshotV1 {
  return record(value) && keys(value, ['version', 'driverId', 'driverRevision', 'schemaVersion', 'context'])
    && value.version === PORTABLE_AGENT_VERSION && nonempty(value.driverId)
    && nonempty(value.driverRevision)
    && Number.isSafeInteger(value.schemaVersion) && Number(value.schemaVersion) > 0 && isJsonValue(value.context)
}

/**
 * Report portability from declared capabilities, without source/target pair adapters.
 * The caller validates parsed data before passing it here and requires explicit
 * acknowledgment of warnings before committing an import.
 * @param context - validated source context.
 * @param target - capabilities declared by the destination driver.
 * @param targetModel - explicitly selected destination model route.
 * @param privateSnapshot - optional validated source-driver checkpoint.
 * @returns fidelity and every detected blocking or acknowledgment issue.
 */
export function assessPortableImportV1(
  context: PortableAgentContextV1,
  target: PortableImportCapabilitiesV1,
  targetModel: AgentDriverStateV1['model'],
  privateSnapshot?: PrivateDriverSnapshotV1,
): PortableImportAssessmentV1 {
  const issues: PortableImportIssueV1[] = []
  if (!target.supportedContextVersions.includes(context.version)) {
    issues.push({ severity: 'error', code: 'context-version', detail: `Unsupported context version ${context.version}` })
  }
  const source = context.source
  const sameDriver = target.driverId === source.driver.id
  const sameModel = targetModel.provider === source.model.provider && targetModel.id === source.model.id
  if (!sameDriver) issues.push({ severity: 'warning', code: 'driver-changed', detail: `Source driver ${source.driver.id} differs from ${target.driverId}` })
  if (!sameModel) issues.push({ severity: 'warning', code: 'model-changed', detail: `Source model ${source.model.provider}/${source.model.id} differs from ${targetModel.provider}/${targetModel.id}` })
  const matchingPrivate = privateSnapshot !== undefined && sameDriver && sameModel && privateSnapshot.driverId === target.driverId
    && target.supportedPrivateSnapshotVersions.includes(privateSnapshot.schemaVersion)
    && target.supportedPrivateRevisions.includes(privateSnapshot.driverRevision)
  if (!matchingPrivate) {
    const activeIds = new Set(context.effectiveItemIds)
    const activeUnknown = new Set<string>()
    const historicalUnknown = new Set<string>()
    const visit = (blocks: readonly PortableContentBlockV1[], active: boolean): void => {
      for (const block of blocks) {
        if (block.kind === 'opaque' && !target.supportedOpaqueNamespaces.includes(block.namespace)) {
          (active ? activeUnknown : historicalUnknown).add(block.namespace)
        }
        if (block.kind === 'tool-result') visit(block.content, active)
      }
    }
    for (const item of context.items) visit(item.content, activeIds.has(item.id))
    for (const namespace of activeUnknown) {
      issues.push({ severity: 'error', code: 'opaque-content', detail: `Unsupported active content namespace ${namespace}` })
    }
    for (const namespace of historicalUnknown) {
      if (!activeUnknown.has(namespace)) {
        issues.push({ severity: 'warning', code: 'opaque-content',
          detail: `Inactive provenance namespace ${namespace} may not be interpreted by ${target.driverId}` })
      }
    }
  }
  if (privateSnapshot !== undefined && !matchingPrivate) {
    issues.push({ severity: 'warning', code: 'private-snapshot', detail: 'Private driver checkpoint cannot be restored by target driver' })
  }
  if (!nonempty(targetModel.provider) || !nonempty(targetModel.id)
    || !target.availableModels.some(model => model.provider === targetModel.provider && model.id === targetModel.id)) {
    issues.push({ severity: 'error', code: 'model-unavailable', detail: `Target model ${targetModel.provider}/${targetModel.id} is unavailable` })
  }
  return {
    fidelity: issues.some(issue => issue.severity === 'error') ? 'unsupported' : matchingPrivate ? 'same-driver' : 'portable',
    issues,
  }
}
