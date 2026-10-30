import type { Entry, ResultImage, ShuttleMessageReceipt } from './records.js'
import type { ShuttleMessage } from './messages.js'
import type { SentFile, SentFileSend } from '../sentFiles.js'

export interface ToolStep {
  kind: 'tool'
  id: string
  name: string
  input: unknown
  at?: number
  result?: { text: string; isError: boolean; images: number; pictures?: ResultImage[]; at?: number }
  version: number
}

export interface SentFileNotice extends SentFileSend {
  kind: 'sent-file'
  at?: number
  files: SentFile[]
}

export type Step = ToolStep | SentFileNotice | Extract<Entry, { kind: 'text' | 'thinking' | 'event' }> | ShuttleMessage

export interface Turn {
  index: number
  prompt: Extract<Entry, { kind: 'prompt' }> | null
  steps: Step[]
  answer: number
  version: number
  startedAt?: number
  endedAt?: number
}

export interface TranscriptStats {
  turns: number
  tools: number
  startedAt?: number
  endedAt?: number
  model?: string
  context?: number
  window?: number
  cacheUntil?: number
  /** The lifetime of the cache entry that sets cacheUntil: an hour or five minutes. */
  cacheTtl?: number
  /** The context tokens read from the prompt cache over every turn of the session that records them, and those turns' context tokens. */
  sessionCache?: { cached: number; context: number }
}

interface ToolReference {
  turn: Turn
  step: ToolStep
}

interface MessageReference {
  message: ShuttleMessage
  turn: Turn
}

function updateTimes(turn: Turn, time: number | undefined): void {
  if (time === undefined) return
  turn.startedAt = turn.startedAt === undefined ? time : Math.min(turn.startedAt, time)
  turn.endedAt = turn.endedAt === undefined ? time : Math.max(turn.endedAt, time)
}

function isShuttleAddress(target: string | undefined): boolean {
  return !!target && /^shuttle:\/\/[^/\s]+\/[^/\s]+\/[^/?#\s]+(?:[?#][^\s]*)?$/.test(target)
}

function isNativeSessionId(target: string | undefined): boolean {
  return !!target && (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(target) || /^[0-9a-f]{24,}$/i.test(target))
}

function shuttleAddressSession(address: string): string | undefined {
  if (!isShuttleAddress(address)) return undefined
  try {
    const segments = new URL(address).pathname.split('/').filter(Boolean)
    return segments.length === 2 ? decodeURIComponent(segments[1]) : undefined
  } catch {
    return undefined
  }
}

function receiptMatchesTarget(receipt: ShuttleMessageReceipt, message: ShuttleMessage): boolean {
  if (!receipt.target) return false
  if (receipt.target === message.target) return true
  return isNativeSessionId(message.target) && shuttleAddressSession(receipt.target) === message.target
}

function matchedReceipts(
  receipts: readonly ShuttleMessageReceipt[],
  messages: readonly ShuttleMessage[],
  completeSendGroup: boolean,
  allowTargetMatching = true,
): Set<ShuttleMessage> {
  const matched = new Set<ShuttleMessage>()
  const usedReceipts = new Set<number>()

  for (const message of messages) {
    if (!message.messageId) continue
    const index = receipts.findIndex((receipt, i) => !usedReceipts.has(i) && receipt.id === message.messageId)
    if (index >= 0) {
      matched.add(message)
      usedReceipts.add(index)
    }
  }

  if (!allowTargetMatching) return matched

  const targets = new Set(receipts.flatMap((receipt, i) => !usedReceipts.has(i) && receipt.target ? [receipt.target] : []))
  for (const target of targets) {
    const indexes = receipts.flatMap((receipt, i) => !usedReceipts.has(i) && receipt.target === target ? [i] : [])
    const candidates = messages.filter(message => !matched.has(message)
      && indexes.some(index => receiptMatchesTarget(receipts[index], message)))
    if (candidates.length === 1 && indexes.length === 1 && !candidates[0].messageId) {
      matched.add(candidates[0])
      usedReceipts.add(indexes[0])
    } else if (completeSendGroup && candidates.length > 1 && indexes.length === candidates.length
      && candidates.every(message => !message.messageId)) {
      for (const message of candidates) matched.add(message)
      for (const index of indexes) usedReceipts.add(index)
    }
  }

  const remainingMessages = messages.filter(message => !matched.has(message))
  const remainingIndexes = receipts.flatMap((_, index) => !usedReceipts.has(index) ? [index] : [])
  const remainingAreAddresses = remainingIndexes.every(index => isShuttleAddress(receipts[index].target))
  const fiberMessages = remainingMessages.filter(message => message.fiber && !message.messageId)
  if (remainingIndexes.length > 0 && remainingAreAddresses
    && fiberMessages.length === remainingMessages.length
    && fiberMessages.length === remainingIndexes.length
    && (fiberMessages.length === 1 || completeSendGroup)) {
    for (const message of fiberMessages) matched.add(message)
    for (const index of remainingIndexes) usedReceipts.add(index)
  }

  const finalMessages = messages.filter(message => !matched.has(message))
  const finalIndexes = receipts.flatMap((_, index) => !usedReceipts.has(index) ? [index] : [])
  if (finalIndexes.length > 0 && finalIndexes.length === finalMessages.length
    && finalIndexes.every(index => !receipts[index].target)
    && finalMessages.every(message => !message.messageId)
    && (finalMessages.length === 1 || completeSendGroup)) {
    for (const message of finalMessages) matched.add(message)
  }

  return matched
}

/** Incrementally folds normalized records into prompt-bounded turns. */
export class TranscriptModel {
  private readonly turnList: Turn[] = []
  private readonly tools = new Map<string, ToolReference>()
  private readonly messages = new Set<string>()
  private readonly messagesByTool = new Map<string, MessageReference[]>()
  private sentFiles = new Map<string, SentFileNotice>()
  private readonly dirty = new Set<number>()
  private resetRequested = false
  private facts: Pick<TranscriptStats, 'model' | 'context' | 'window' | 'cacheUntil' | 'cacheTtl' | 'sessionCache'> = {}

  private hourCacheUntil: number | undefined
  private shortCacheUntil: number | undefined

  get turns(): readonly Turn[] {
    return this.turnList
  }

  append(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (entry.kind === 'shuttle-message') {
        if (this.messages.has(entry.id)) continue
        this.messages.add(entry.id)
      }
      if (entry.kind === 'usage') {
        if (entry.model) this.facts.model = entry.model
        this.facts.context = entry.context
        this.facts.window = entry.window
        if (entry.cached !== undefined && entry.context) {
          const sum = this.facts.sessionCache ?? { cached: 0, context: 0 }
          this.facts.sessionCache = { cached: sum.cached + Math.min(entry.cached, entry.context), context: sum.context + entry.context }
        }
        const cache = entry.cache
        if (cache && entry.at !== undefined && (cache.read > 0 || cache.write > 0)) {
          const hourRead = cache.read > 0 && this.hourCacheUntil !== undefined && this.hourCacheUntil > entry.at
          if (cache.hourWrite > 0 || hourRead) this.hourCacheUntil = entry.at + 3_600_000
          if (cache.write > cache.hourWrite || (cache.read > 0 && !hourRead)) this.shortCacheUntil = entry.at + 300_000
          this.facts.cacheUntil = Math.max(this.hourCacheUntil ?? 0, this.shortCacheUntil ?? 0)
          this.facts.cacheTtl = this.facts.cacheUntil === this.hourCacheUntil ? 3_600_000 : 300_000
        }
        continue
      }
      if (entry.kind === 'event' && entry.contextReset) {
        this.facts.context = entry.context
        this.facts.cacheUntil = this.facts.cacheTtl = undefined
        this.hourCacheUntil = this.shortCacheUntil = undefined
      }
      if (entry.kind === 'result') {
        const reference = this.tools.get(entry.id)
        const messages = this.messagesByTool.get(entry.id) ?? []
        if (reference) {
          reference.step.result = {
            text: entry.text,
            isError: entry.isError,
            images: entry.images,
            ...(entry.pictures ? { pictures: entry.pictures } : {}),
            ...(entry.at === undefined ? {} : { at: entry.at }),
          }
          reference.step.version++
        }
        const explicitlyIndexed = (entry.commandOutcomes?.length ?? 0) > 0 && entry.commandOutcomes!.every(outcome => outcome.index !== undefined)
        const indexedOutcomes = entry.commandOutcomes ?? []
        const rowsByCommand = new Map<number, typeof messages>()
        for (const row of messages) {
          const commandIndex = row.message.commandIndex ?? 0
          rowsByCommand.set(commandIndex, [...(rowsByCommand.get(commandIndex) ?? []), row])
        }
        const allSegmentsAreMessages = messages.length > 0 && [...rowsByCommand.values()].every(rows =>
          rows.length === (rows[0].message.commandSegmentCount ?? 1))
        const topLevelReceiptsTrusted = messages.every(({ message }) => !message.resultMayBeUnattributed)
        const topLevelAcceptedReceipts = topLevelReceiptsTrusted ? entry.acceptedMessageReceipts ?? [] : []
        const topLevelUnknownReceipts = topLevelReceiptsTrusted ? entry.unknownMessageReceipts ?? [] : []
        const topLevelAcceptedMatches = matchedReceipts(
          topLevelAcceptedReceipts, messages.map(row => row.message), allSegmentsAreMessages && !explicitlyIndexed, !explicitlyIndexed,
        )
        const topLevelUnknownMatches = matchedReceipts(
          topLevelUnknownReceipts, messages.map(row => row.message), allSegmentsAreMessages && !explicitlyIndexed, !explicitlyIndexed,
        )
        for (const reference of messages) {
          const message = reference.message
          const commandIndex = message.commandIndex ?? 0
          const commandRows = rowsByCommand.get(commandIndex) ?? []
          const matchingOutcomes = message.resultMayBeUnattributed ? [] : indexedOutcomes.filter(outcome => outcome.index !== undefined
            ? outcome.index === commandIndex
            : indexedOutcomes.length === 1 && (message.commandCount ?? 1) === 1)
          const outcomeText = matchingOutcomes.length === 1 ? matchingOutcomes[0].output ?? entry.text : entry.text
          const topAccepted = message.resultMayBeUnattributed && !message.messageId ? [] : (entry.acceptedMessageReceipts ?? []).map(receipt => receipt.id)
          const topUnknown = message.resultMayBeUnattributed && !message.messageId ? [] : (entry.unknownMessageReceipts ?? []).map(receipt => receipt.id)
          const commandAcceptedReceipts = matchingOutcomes.flatMap(outcome => outcome.acceptedMessageReceipts)
          const commandUnknownReceipts = matchingOutcomes.flatMap(outcome => outcome.unknownMessageReceipts)
          const commandAcceptedMatches = matchedReceipts(
            commandAcceptedReceipts,
            commandRows.map(row => row.message),
            commandRows.length > 0 && commandRows.length === (message.commandSegmentCount ?? 1),
          )
          const commandUnknownMatches = matchedReceipts(
            commandUnknownReceipts,
            commandRows.map(row => row.message),
            commandRows.length > 0 && commandRows.length === (message.commandSegmentCount ?? 1),
          )
          const explicitIdOutcomes = message.messageId ? indexedOutcomes : []
          const acceptedIds = [...topAccepted, ...commandAcceptedReceipts.map(receipt => receipt.id), ...explicitIdOutcomes.flatMap(outcome => outcome.acceptedMessageReceipts.map(receipt => receipt.id))]
          const receiptMatches = message.messageId
            ? acceptedIds.includes(message.messageId)
            : topLevelAcceptedMatches.has(message) || commandAcceptedMatches.has(message)
          if (receiptMatches) {
            message.status = 'sent'
            message.outcomeText = undefined
            continue
          }

          const unknownIds = [...topUnknown, ...commandUnknownReceipts.map(receipt => receipt.id), ...explicitIdOutcomes.flatMap(outcome => outcome.unknownMessageReceipts.map(receipt => receipt.id))]
          const unknownReceiptMatches = message.messageId
            ? unknownIds.includes(message.messageId)
              : topLevelUnknownMatches.has(message) || commandUnknownMatches.has(message)
          if (unknownReceiptMatches) {
            message.status = 'uncertain'
            message.outcomeText = message.hideTool ? outcomeText.trim() || undefined : undefined
            continue
          }

          const exitCode = matchingOutcomes.length === 1 ? matchingOutcomes[0].exitCode : undefined
          const failed = exitCode !== undefined ? exitCode !== 0
            : entry.isError && indexedOutcomes.length === 0 && !message.resultMayBeUnattributed
          if (!failed) {
            message.status = 'uncertain'
          } else if ((explicitlyIndexed || (message.commandCount ?? 1) === 1)
            && commandRows.length === 1
            && (message.commandSegmentCount ?? 1) === 1) {
            message.status = 'failed'
          } else {
            message.status = 'uncertain'
          }
          message.outcomeText = message.hideTool ? outcomeText.trim() || undefined : undefined
        }
        const touched = new Set<Turn>()
        for (const message of messages) touched.add(message.turn)
        if (reference) touched.add(reference.turn)
        for (const turn of touched) {
          updateTimes(turn, entry.at)
          this.touch(turn)
        }
        continue
      }

      if (entry.kind === 'prompt') {
        const turn: Turn = {
          index: this.turnList.length,
          prompt: entry,
          steps: [],
          answer: -1,
          version: 0,
          ...(entry.at === undefined ? {} : { startedAt: entry.at, endedAt: entry.at }),
        }
        this.turnList.push(turn)
        this.touch(turn)
        continue
      }

      const turn = this.currentTurn() ?? this.createTurn()
      if (entry.kind === 'tool') {
        const step: ToolStep = {
          kind: 'tool', id: entry.id, name: entry.name, input: entry.input, version: 0,
          ...(entry.at === undefined ? {} : { at: entry.at }),
        }
        turn.steps.push(step)
        this.tools.set(entry.id, { turn, step })
      } else {
        turn.steps.push(entry)
        if (entry.kind === 'text') turn.answer = turn.steps.length - 1
        if (entry.kind === 'shuttle-message' && entry.direction === 'sent' && entry.toolId) {
          this.messagesByTool.set(entry.toolId, [...(this.messagesByTool.get(entry.toolId) ?? []), { message: entry, turn }])
        }
      }
      updateTimes(turn, entry.at)
      this.touch(turn)
    }
  }

  /** Return the turns whose views changed since the last read. */
  takeChanges(): { reset: boolean; turns: number[] } {
    const changes = { reset: this.resetRequested, turns: [...this.dirty].sort((a, b) => a - b) }
    this.resetRequested = false
    this.dirty.clear()
    return changes
  }

  reset(): void {
    this.turnList.length = 0
    this.tools.clear()
    this.messages.clear()
    this.messagesByTool.clear()
    this.sentFiles.clear()
    this.dirty.clear()
    this.resetRequested = true
    this.facts = {}
    this.hourCacheUntil = this.shortCacheUntil = undefined
  }

  /** Replace the external send rows with the current receipt set for this session. */
  setSentFiles(entries: readonly SentFileNotice[]): void {
    const next = new Map(entries.map((entry) => [entry.id, entry] as const))
    if (sameSentFiles(this.sentFiles, next)) return
    this.sentFiles = next
    this.placeSentFiles()
  }

  /** Place receipt rows against the transcript's current turn boundaries. */
  placeSentFiles(): void {
    if (!this.turnList.length) return
    const desired: Step[][] = this.turnList.map(turn => turn.steps.filter(step => step.kind !== 'sent-file'))
    for (const entry of [...this.sentFiles.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.id.localeCompare(b.id))) {
      const turn = this.turnForSentFile(entry.at)
      const steps = desired[turn.index]
      const index = entry.at === undefined ? -1 : steps.findIndex(step => step.at !== undefined && step.at > entry.at!)
      steps.splice(index < 0 ? steps.length : index, 0, entry)
    }
    for (const turn of this.turnList) {
      const steps = desired[turn.index]
      if (steps.length === turn.steps.length && steps.every((step, i) => step === turn.steps[i])) continue
      turn.steps.splice(0, turn.steps.length, ...steps)
      this.recomputeTurn(turn)
      this.touch(turn)
    }
  }

  stats(): TranscriptStats {
    let startedAt: number | undefined
    let endedAt: number | undefined
    let model: string | undefined
    let tools = 0
    for (const turn of this.turnList) {
      if (turn.startedAt !== undefined) startedAt = startedAt === undefined ? turn.startedAt : Math.min(startedAt, turn.startedAt)
      if (turn.endedAt !== undefined) endedAt = endedAt === undefined ? turn.endedAt : Math.max(endedAt, turn.endedAt)
      for (const step of turn.steps) {
        if (step.kind === 'tool') tools++
        else if (model === undefined && step.kind === 'text' && step.model) model = step.model
      }
    }
    return {
      turns: this.turnList.length,
      tools,
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(endedAt === undefined ? {} : { endedAt }),
      ...(model === undefined ? {} : { model }),
      ...this.facts,
    }
  }

  toolCounts(turn: Turn): Record<string, number> {
    const counts = new Map<string, number>()
    for (const step of turn.steps) {
      if (step.kind === 'tool') counts.set(step.name, (counts.get(step.name) ?? 0) + 1)
    }
    return Object.fromEntries(counts)
  }

  private currentTurn(): Turn | undefined {
    return this.turnList[this.turnList.length - 1]
  }

  private createTurn(): Turn {
    const turn: Turn = {
      index: this.turnList.length,
      prompt: null,
      steps: [],
      answer: -1,
      version: 0,
    }
    this.turnList.push(turn)
    return turn
  }

  private turnForSentFile(at: number | undefined): Turn {
    const last = this.currentTurn()
    if (at === undefined || !this.turnList.length) return last ?? this.createTurn()
    let candidate = this.turnList[0]
    for (const turn of this.turnList) {
      const start = turn.prompt?.at ?? turn.startedAt
      if (start === undefined || start <= at) candidate = turn
      else break
    }
    return candidate
  }

  private recomputeTurn(turn: Turn): void {
    const times: number[] = []
    if (turn.prompt?.at !== undefined) times.push(turn.prompt.at)
    for (const step of turn.steps) {
      if (step.at !== undefined) times.push(step.at)
      if (step.kind === 'tool' && step.result?.at !== undefined) times.push(step.result.at)
    }
    turn.startedAt = times.length ? Math.min(...times) : undefined
    turn.endedAt = times.length ? Math.max(...times) : undefined
    turn.answer = turn.steps.reduce((answer, step, index) => step.kind === 'text' ? index : answer, -1)
  }

  private touch(turn: Turn): void {
    turn.version++
    this.dirty.add(turn.index)
  }
}

/** A turn's steps as the reader lays them out: each agent message on its own, the work between messages as one run. */
export type Segment =
  | { kind: 'text'; index: number }
  | { kind: 'shuttle-message'; index: number }
  | { kind: 'sent-file'; index: number }
  | { kind: 'steps'; start: number; end: number }

export function segments(steps: readonly Step[]): Segment[] {
  const out: Segment[] = []
  let runStart = -1
  steps.forEach((step, index) => {
    if (step.kind === 'text' || step.kind === 'shuttle-message' || step.kind === 'sent-file') {
      if (runStart >= 0) out.push({ kind: 'steps', start: runStart, end: index })
      runStart = -1
      out.push({ kind: step.kind, index })
    } else if (runStart < 0) runStart = index
  })
  if (runStart >= 0) out.push({ kind: 'steps', start: runStart, end: steps.length })
  return out
}

function sameSentFiles(a: ReadonlyMap<string, SentFileNotice>, b: ReadonlyMap<string, SentFileNotice>): boolean {
  if (a.size !== b.size) return false
  for (const [id, left] of a) {
    const right = b.get(id)
    if (!right || left.at !== right.at || left.files.length !== right.files.length) return false
    for (let index = 0; index < left.files.length; index++) {
      if (left.files[index].fullPath !== right.files[index].fullPath || left.files[index].basename !== right.files[index].basename) return false
    }
  }
  return true
}
