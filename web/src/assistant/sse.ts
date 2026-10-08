// Incremental SSE parser for a fetch body. Events are validated with the shared contract (events.ts).
import { sseEventSchema, type SseEvent } from '../../agent/harness/events'

export type SseParseError = { kind: 'parse_error'; message: string; raw: string }
export type SseItem = { ok: true; event: SseEvent } | { ok: false; error: SseParseError }

/** Stateful line/event assembler. Feed it decoded text; it returns the items completed so far. */
export class SseAssembler {
  private buf = ''
  private eventName = ''
  private dataLines: string[] = []
  private hasData = false

  push(text: string): SseItem[] {
    this.buf += text
    const out: SseItem[] = []
    let start = 0
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i]
      if (c !== '\n' && c !== '\r') continue
      if (c === '\r') {
        if (i === this.buf.length - 1) break // a following \n may arrive in the next chunk
        const end = this.buf[i + 1] === '\n' ? i + 1 : i
        this.line(this.buf.slice(start, i), out)
        i = end
        start = end + 1
      } else {
        this.line(this.buf.slice(start, i), out)
        start = i + 1
      }
    }
    this.buf = this.buf.slice(start)
    return out
  }

  private line(line: string, out: SseItem[]): void {
    if (line === '') {
      this.dispatch(out)
      return
    }
    if (line.startsWith(':')) return // comment / heartbeat
    const idx = line.indexOf(':')
    const field = idx === -1 ? line : line.slice(0, idx)
    let value = idx === -1 ? '' : line.slice(idx + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') this.eventName = value
    else if (field === 'data') {
      this.dataLines.push(value)
      this.hasData = true
    }
    // id / retry / unknown fields are ignored
  }

  private dispatch(out: SseItem[]): void {
    const name = this.eventName
    const raw = this.dataLines.join('\n')
    const had = this.hasData
    this.eventName = ''
    this.dataLines = []
    this.hasData = false
    if (!had) return
    let data: unknown
    try {
      data = JSON.parse(raw)
    } catch {
      out.push({ ok: false, error: { kind: 'parse_error', message: `Event "${name}" has invalid JSON data`, raw } })
      return
    }
    const parsed = sseEventSchema.safeParse({ type: name, data })
    if (parsed.success) out.push({ ok: true, event: parsed.data })
    else {
      const why = parsed.error.issues[0]?.message ?? 'unknown'
      out.push({ ok: false, error: { kind: 'parse_error', message: `Invalid "${name || '(no name)'}" event: ${why}`, raw } })
    }
  }
}

/** Read a byte stream and yield validated events (or typed parse errors). An incomplete trailing event is dropped. */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseItem> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8')
  const asm = new SseAssembler()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (const item of asm.push(decoder.decode(value, { stream: true }))) yield item
    }
    for (const item of asm.push(decoder.decode())) yield item
  } finally {
    reader.releaseLock()
  }
}
