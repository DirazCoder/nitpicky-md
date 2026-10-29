// decision trace. opt-in: parse(md, {trace: true}). the recorder is a
// dedicated object when tracing, undefined when not -- parsers check for it
// and move on. events carry enough to answer "why did this text parse the
// way it did" (provenance) and "what almost worked" (diagnostics).

export type TracePhase = 'block' | 'inline'

export interface TraceEvent {
  /** what was tried, e.g. 'atx-heading', 'emphasis', 'link' */
  readonly construct: string
  readonly phase: TracePhase
  readonly verdict: 'accepted' | 'rejected'
  /** machine-readable reason, e.g. 'no-space-after-hash', 'rule-of-three' */
  readonly reason?: string
  readonly start?: number
  readonly end?: number
  /** spec citation when one construct maps cleanly, e.g. 'CommonMark 0.31.2 §4.2' */
  readonly spec?: string
}

/** a construct almost matched; the raw material for diagnostics */
export interface NearMiss {
  code: string
  offset: number
  /** extra context for fix building, e.g. the fence string to append */
  detail?: string | undefined
}

export interface TraceRecorder {
  push(event: TraceEvent): void
  readonly events: readonly TraceEvent[]
}

export function createRecorder(): TraceRecorder {
  const events: TraceEvent[] = []
  return {
    push(event: TraceEvent): void {
      // cap so a pathological document can't balloon memory; a million
      // decisions is plenty for explain() on any sane file
      if (events.length < 1_000_000) events.push(event)
    },
    get events(): readonly TraceEvent[] {
      return events
    },
  }
}
