/**
 * Narrow, transport-independent contract for the Codex app-server methods
 * used by the DSH agent provider. It follows the generated 0.149.1 protocol;
 * unknown server-initiated methods remain closed by default.
 *
 * @module @deepseek-ai/dsh-agent-codex/protocol
 */

import type { CodexThreadId, CodexTurnId } from './types.ts'

export type CodexJsonObject = Record<string, unknown>

/** App-server protocol revision against which this adapter is implemented. */
export const CODEX_PROTOCOL_VERSION = '0.149.1'
/** Backward-compatible protocol label; runtime provenance is recorded separately. */
export const CODEX_RUNTIME_VERSION = CODEX_PROTOCOL_VERSION

/** Native Codex user input admitted by the current app-server protocol. */
export type CodexUserInput =
  | { readonly type: 'text'; readonly text: string; readonly text_elements: readonly unknown[] }
  | { readonly type: 'image'; readonly url: string }
  | { readonly type: 'localImage'; readonly path: string }

/** Thread policy stays native; DSH does not emulate Codex's sandbox. */
export interface CodexThreadOptions {
  readonly cwd: string
  readonly model?: string
  readonly approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never'
  readonly approvalsReviewer?: 'user' | 'auto_review'
  readonly sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access'
}

export interface CodexTurnRef {
  readonly threadId: CodexThreadId
  readonly turnId: CodexTurnId
}

export interface CodexNotification {
  readonly method: string
  readonly params: CodexJsonObject
}

export type CodexInteractionMethod =
  | 'item/commandExecution/requestApproval'
  | 'item/fileChange/requestApproval'
  | 'item/permissions/requestApproval'
  | 'item/tool/requestUserInput'
  | 'mcpServer/elicitation/request'
  | 'item/tool/call'
  | 'account/chatgptAuthTokens/refresh'
  | 'attestation/generate'
  | 'applyPatchApproval'
  | 'execCommandApproval'

/** Product-owned handler for app-server initiated requests. */
export type CodexInteractionHandler = (
  method: CodexInteractionMethod,
  params: CodexJsonObject,
) => Promise<unknown>

/** Minimal JSON-RPC peer; production and tests can supply different transports. */
export interface CodexAppServerTransport {
  start(): void
  close(): void
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown>
  notify(method: string, params?: object): void
  flush(): Promise<void>
  onRequest(handler: (method: string, params: CodexJsonObject) => Promise<unknown>): void
  onNotification(handler: (method: string, params: CodexJsonObject) => void): void
}

/** Persistent app-server operations consumed by the agent driver. */
export interface CodexAppServer {
  initialize(signal?: AbortSignal): Promise<void>
  startThread(options: CodexThreadOptions, signal?: AbortSignal): Promise<CodexThreadId>
  resumeThread(threadId: CodexThreadId, options: CodexThreadOptions, signal?: AbortSignal): Promise<void>
  startTurn(
    threadId: CodexThreadId,
    input: readonly CodexUserInput[],
    signal?: AbortSignal,
    effort?: string,
  ): Promise<CodexTurnRef>
  steerTurn(turn: CodexTurnRef, input: readonly CodexUserInput[], signal?: AbortSignal): Promise<void>
  interruptTurn(turn: CodexTurnRef, signal?: AbortSignal): Promise<void>
  subscribe(listener: (notification: CodexNotification) => void): () => void
  subscribeTurn(turn: CodexTurnRef, listener: (notification: CodexNotification) => void): () => void
  close(): void
}
