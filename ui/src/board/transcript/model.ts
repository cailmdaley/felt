import type { Entry } from './records.js'

export interface ToolStep {
  kind: 'tool'
  id: string
  name: string
  input: unknown
  at?: number
  result?: { text: string; isError: boolean; images: number; at?: number }
  version: number
}

export type Step = ToolStep | Extract<Entry, { kind: 'text' | 'thinking' | 'event' }>

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
}

interface ToolReference {
  turn: Turn
  step: ToolStep
}

function updateTimes(turn: Turn, time: number | undefined): void {
  if (time === undefined) return
  turn.startedAt = turn.startedAt === undefined ? time : Math.min(turn.startedAt, time)
  turn.endedAt = turn.endedAt === undefined ? time : Math.max(turn.endedAt, time)
}

/** Incrementally folds normalized records into prompt-bounded turns. */
export class TranscriptModel {
  private readonly turnList: Turn[] = []
  private readonly tools = new Map<string, ToolReference>()
  private readonly dirty = new Set<number>()
  private resetRequested = false

  get turns(): readonly Turn[] {
    return this.turnList
  }

  append(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (entry.kind === 'result') {
        const reference = this.tools.get(entry.id)
        if (!reference) continue
        reference.step.result = {
          text: entry.text,
          isError: entry.isError,
          images: entry.images,
          ...(entry.at === undefined ? {} : { at: entry.at }),
        }
        reference.step.version++
        updateTimes(reference.turn, entry.at)
        this.touch(reference.turn)
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
    this.dirty.clear()
    this.resetRequested = true
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

  private touch(turn: Turn): void {
    turn.version++
    this.dirty.add(turn.index)
  }
}

/** A turn's steps as the reader lays them out: each agent message on its own, the work between messages as one run. */
export type Segment =
  | { kind: 'text'; index: number }
  | { kind: 'steps'; start: number; end: number }

export function segments(steps: readonly Step[]): Segment[] {
  const out: Segment[] = []
  let runStart = -1
  steps.forEach((step, index) => {
    if (step.kind === 'text') {
      if (runStart >= 0) out.push({ kind: 'steps', start: runStart, end: index })
      runStart = -1
      out.push({ kind: 'text', index })
    } else if (runStart < 0) runStart = index
  })
  if (runStart >= 0) out.push({ kind: 'steps', start: runStart, end: steps.length })
  return out
}
