/** Admission of opaque compaction JSON without retaining object or string payloads. */

import { createHash } from 'node:crypto'
import { Readable, type Duplex } from 'node:stream'
import { parser } from 'stream-json'
import type { Token } from 'stream-json/core/parser.js'
import type { PortableCompactionV1, PortableOpaqueContextItemStreamV1 } from '@deepseek-ai/dsh-agent'

/** Receipt-verified JSON with the audited prompt implementation, when present. */
export interface CodexPortableJsonStream {
  readonly encoding: 'codex-json'
  readonly read: () => AsyncIterable<Uint8Array>
  readonly json: PortableOpaqueContextItemStreamV1['json']
  readonly mode: PortableCompactionV1['mode'] | undefined
}

/** Validate a complete single JSON value and extract only compaction implementation metadata.
 * Strings, keys and numbers are consumed in pieces without retaining complete scalars.
 * The reader must verify ownership and its receipt on every invocation.
 * @param read - fresh reader of the same session-owned bytes on each invocation.
 * @param receipt - declared exact bytes and digest.
 * @param prompt - require an object with a supported audited implementation.
 * @returns verified metadata and a fresh byte stream for archive encoding.
 */
export async function admitCodexPortableJson(
  read: () => AsyncIterable<Uint8Array>,
  receipt: { readonly bytes: number; readonly sha256: string },
  prompt: boolean,
): Promise<CodexPortableJsonStream> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  const text = async function* () {
    for await (const chunk of read()) {
      for (let offset = 0; offset < chunk.length; offset += 16384) {
        yield decoder.decode(chunk.subarray(offset, offset + 16384), { stream: true })
      }
    }
    yield decoder.decode()
  }
  const tokens = Readable.from(text()).compose<Duplex>(parser.asStream({
    packValues: false,
  }))
  let depth = 0
  let rootObject = false
  let first = true
  let metadataObject = false
  let key = ''
  let capture: 'key' | 'implementation' | undefined
  let captured = ''
  let implementation: string | undefined
  let number = new JsonNumberAdmission()
  for await (const raw of tokens) {
    const token = raw as Token
    if (first) { rootObject = token.name === 'startObject'; first = false }
    switch (token.name) {
      case 'startKey': capture = 'key'; captured = ''; break
      case 'stringChunk':
        // These two protocol names are short; other keys and values need no storage.
        if (capture !== undefined && captured.length <= 32) captured += token.value.slice(0, 33)
        break
      case 'endKey':
        key = captured
        capture = undefined
        if (depth === 1 && key === 'compactionMetadata') {
          implementation = undefined
          metadataObject = false
        }
        if (depth === 2 && metadataObject && key === 'implementation') implementation = undefined
        break
      case 'startObject':
        if (depth === 1 && key === 'compactionMetadata') metadataObject = true
        depth++
        break
      case 'startArray': depth++; break
      case 'endObject':
      case 'endArray':
        depth--
        if (depth === 1) metadataObject = false
        break
      case 'startString':
        if (depth === 2 && metadataObject && key === 'implementation') {
          capture = 'implementation'; captured = ''
        }
        break
      case 'endString':
        if (capture === 'implementation') implementation = captured
        capture = undefined
        break
      case 'startNumber': number = new JsonNumberAdmission(); break
      case 'numberChunk': number.append(token.value); break
      case 'endNumber': number.finish(); break
      default: break
    }
  }
  const mode = rootObject && implementation === 'responses' ? 'local'
    : rootObject && implementation === 'responses_compaction_v2' ? 'remote' : undefined
  if (prompt && mode === undefined) throw new Error('Codex compaction prompt has no supported audited implementation')
  return { encoding: 'codex-json', read, json: { bytes: receipt.bytes, sha256: receipt.sha256, chunks: read() }, mode }
}

/** Wrap verified failure details while retaining the ordinary canonical failure value.
 * @param message - complete recorded failure message.
 * @param details - admitted JSON details.
 * @returns an opaque JSON stream whose receipt covers the entire wrapper.
 */
export async function codexPortableFailureJson(
  message: string,
  details: CodexPortableJsonStream,
): Promise<CodexPortableJsonStream> {
  const prefix = Buffer.from(`{"message":${JSON.stringify(message)},"details":`)
  const suffix = Buffer.from('}')
  const hash = createHash('sha256').update(prefix)
  for await (const chunk of details.read()) hash.update(chunk)
  hash.update(suffix)
  const read = async function* () {
    yield prefix
    yield* details.read()
    yield suffix
  }
  return { encoding: 'codex-json', mode: undefined, read,
    json: { chunks: read(), bytes: prefix.length + details.json.bytes + suffix.length, sha256: hash.digest('hex') } }

}

// Every binary64 rounding boundary has fewer than 1100 significant decimal digits.
// A sticky digit distinguishes an exact boundary from a nonzero discarded tail.
class JsonNumberAdmission {
  private negative = false
  private fraction = false
  private exponent = false
  private exponentNegative = false
  private exponentValue = 0n
  private fractionDigits = 0n
  private significantDigits = 0n
  private digits = ''
  private sticky = false

  append(chunk: string): void {
    for (const char of chunk) {
      if (char === '-') { if (this.exponent) this.exponentNegative = true; else this.negative = true }
      else if (char === '.') this.fraction = true
      else if (char === 'e' || char === 'E') this.exponent = true
      else if (char !== '+') {
        if (this.exponent) {
          // Artifact sizes are safe integers, so a larger exponent cannot cancel their digit count.
          if (this.exponentValue <= BigInt(Number.MAX_SAFE_INTEGER) * 2n) {
            this.exponentValue = this.exponentValue * 10n + BigInt(char)
          }
        } else {
          if (this.fraction) this.fractionDigits++
          if (char !== '0' || this.significantDigits > 0n) {
            this.significantDigits++
            if (this.digits.length < 1100) this.digits += char
            else if (char !== '0') this.sticky = true
          }
        }
      }
    }
  }

  finish(): void {
    const digits = this.digits + (this.sticky ? '1' : '')
    const exponent = (this.exponentNegative ? -this.exponentValue : this.exponentValue)
      - this.fractionDigits + this.significantDigits - BigInt(digits.length)
    const value = this.significantDigits === 0n ? (this.negative ? -0 : 0)
      : Number(`${this.negative ? '-' : ''}${digits}e${exponent}`)
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error('Codex portable payload is not lossless JSON')
  }
}
