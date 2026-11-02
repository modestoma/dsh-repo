/**
 * Reading a CI job log as a stream: cleanup of GitLab and GitHub log markup,
 * line numbering, and the tail or search excerpt a job log call returns.
 *
 * - Memory stays bounded by the output budget: the stream is decoded line by
 *   line and only the excerpt being built is kept.
 * - Cleanup removes ANSI escape sequences, keeps the last state of lines
 *   redrawn with carriage returns, removes GitHub's per-line timestamps, and
 *   turns GitLab `section_start`/`section_end` markers and GitHub
 *   `##[group]`/`##[endgroup]` markers into `▶ title` lines.
 * - Line numbers count cleaned lines of the whole log, independent of the
 *   section filter, so `beforeLine` from one call pages back in the next.
 *
 * @module dsh-repo/ci/log
 */

import { truncateBytes } from '../providers/types.ts'

/** Most section titles listed in a result. */
const MAX_SECTIONS = 100

// GitLab: `section_start:<epoch>:<name>[<options>]\r\x1b[0K` and `section_end:<epoch>:<name>\r\x1b[0K`.
const GITLAB_SECTION = /section_(start|end):\d+:([^\s[\r\x1b]+)(?:\[[^\]]*\])?\r?(?:\x1b\[0K)?/g
// CSI sequences, OSC sequences, and two-byte escapes.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
// GitHub Actions prefixes every line with an ISO timestamp.
const GITHUB_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/
const GITHUB_GROUP = '##[group]'
const GITHUB_END_GROUP = '##[endgroup]'

/** What one call asks of a log. */
export interface LogQuery {
  /** Lines containing any of these texts, ignoring case; absent or empty returns the tail. */
  readonly search?: readonly string[]
  /** Lines kept before and after each matching line. */
  readonly context: number
  /** Only lines inside a section whose title contains this text, ignoring case. */
  readonly section?: string
  /** Tail mode: only lines numbered below this. */
  readonly beforeLine?: number
  /** UTF-8 bytes of the returned text, and of the longest kept line. */
  readonly maxBytes: number
}

/** The excerpt of one log. */
export interface LogExcerpt {
  /** Cleaned lines in the whole log. */
  readonly totalLines: number
  /** Number of the first line in {@link text}; absent when nothing was selected. */
  readonly fromLine?: number
  /** Number of the last line in {@link text}. */
  readonly toLine?: number
  /** Tail: the lines as they are; search: each line as `<number>: <text>`, separate excerpts divided by `--`. */
  readonly text: string
  /** Tail: earlier selected lines were left out; search: matches were left out because the text reached its limit. */
  readonly more: boolean
  /** Search: lines that matched. */
  readonly matches?: number
  /** Section titles in order of appearance, without repeats. */
  readonly sections: readonly string[]
  readonly sectionsTruncated: boolean
}

/** One cleaned line. */
interface CleanLine {
  readonly text: string
  /** Titles of the sections the line is in, outermost first. */
  readonly sections: readonly string[]
}

/** Turns raw log lines into cleaned lines while tracking sections. */
export class LogCleaner {
  private readonly stack: string[] = []
  private first = true

  /**
   * Clean one raw line (without its trailing newline).
   * @param raw - the line as the host sent it.
   * @returns the cleaned line, or undefined for a line that only carried markers.
   */
  line(raw: string): { line?: CleanLine; opened?: string } {
    let text = raw
    if (this.first) {
      text = text.replace(/^\uFEFF/, '')
      this.first = false
    }
    text = text.replace(GITHUB_TIME, '')
    let opened: string | undefined
    let marked = false
    text = text.replace(GITLAB_SECTION, (_match, kind: string, name: string) => {
      marked = true
      if (kind === 'start') {
        this.stack.push(name)
        opened = name
      } else {
        const at = this.stack.lastIndexOf(name)
        if (at >= 0) this.stack.splice(at)
      }
      return ''
    })
    text = text.replace(ANSI, '')
    // A carriage return redraws the line: keep the last segment with content.
    if (text.includes('\r')) text = text.split('\r').reverse().find(segment => segment.trim() !== '') ?? ''
    if (text.startsWith(GITHUB_END_GROUP)) {
      this.stack.pop()
      return {}
    }
    if (text.startsWith(GITHUB_GROUP)) {
      const title = text.slice(GITHUB_GROUP.length).trim()
      this.stack.push(title)
      return { line: { text: `▶ ${title}`, sections: [...this.stack] }, opened: title }
    }
    if (opened !== undefined) return { line: { text: `▶ ${text.trim() === '' ? opened : `${opened}: ${text.trim()}`}`, sections: [...this.stack] }, opened }
    if (marked && text.trim() === '') return {}
    return { line: { text, sections: [...this.stack] } }
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

const ELLIPSIS = '…'

/** Cut one line to the byte limit, marking the cut with an ellipsis. */
function capLine(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  return `${truncateBytes(text, Math.max(0, maxBytes - byteLength(ELLIPSIS))).text}${ELLIPSIS}`
}

/**
 * Split a byte stream into raw lines, decoding UTF-8 across chunks. A line
 * longer than `maxChars` is cut one character past it and the rest of it skipped.
 */
async function* rawLines(body: ReadableStream<Uint8Array>, maxChars: number, signal: AbortSignal): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8')
  const reader = body.getReader()
  let pending = ''
  let skipping = false
  try {
    for (;;) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true })
      let start = 0
      for (let newline = chunk.indexOf('\n'); newline >= 0; newline = chunk.indexOf('\n', start)) {
        const piece = chunk.slice(start, newline)
        start = newline + 1
        if (skipping) {
          skipping = false
          yield pending
        } else {
          yield pending + piece
        }
        pending = ''
      }
      if (!skipping) {
        pending += chunk.slice(start)
        if (pending.length > maxChars) {
          // One character past the limit, so the line is still seen as cut.
          pending = pending.slice(0, maxChars + 1)
          skipping = true
        }
      }
      if (done) break
    }
    if (pending !== '') yield pending
  } finally {
    await reader.cancel().catch((error: unknown) => {
      // The stream already ended or failed; the excerpt is complete either way.
      void error
    })
  }
}

/**
 * Read a log stream and build the excerpt a query asks for.
 * @param body - the log as bytes.
 * @param query - tail or search, section filter, and output limit.
 * @param signal - aborts the read.
 * @returns the excerpt.
 */
export async function readLog(body: ReadableStream<Uint8Array>, query: LogQuery, signal: AbortSignal): Promise<LogExcerpt> {
  const cleaner = new LogCleaner()
  const sections: string[] = []
  let sectionsTruncated = false
  const wanted = query.section?.toLowerCase()
  const terms = (query.search ?? []).map(term => term.toLowerCase()).filter(term => term !== '')
  const tail = terms.length === 0 ? new TailWindow(query.maxBytes) : undefined
  const search = tail === undefined ? new SearchWindow(terms, query.context, query.maxBytes) : undefined
  let number = 0
  for await (const raw of rawLines(body, query.maxBytes, signal)) {
    const { line, opened } = cleaner.line(raw)
    if (opened !== undefined && !sections.includes(opened)) {
      if (sections.length < MAX_SECTIONS) sections.push(opened)
      else sectionsTruncated = true
    }
    if (line === undefined) continue
    number += 1
    if (wanted !== undefined && !line.sections.some(title => title.toLowerCase().includes(wanted))) continue
    const text = capLine(line.text, query.maxBytes)
    if (tail !== undefined) {
      if (query.beforeLine === undefined || number < query.beforeLine) tail.add(number, text)
    } else {
      search?.add(number, text)
    }
  }
  const excerpt = tail?.result() ?? search?.result() ?? { text: '', more: false }
  return { totalLines: number, ...excerpt, sections, sectionsTruncated }
}

type Excerpt = Pick<LogExcerpt, 'fromLine' | 'toLine' | 'text' | 'more' | 'matches'>

/** The last lines that fit the byte budget. */
class TailWindow {
  private readonly lines: { readonly number: number; readonly text: string; readonly bytes: number }[] = []
  private bytes = 0
  private dropped = false

  constructor(private readonly maxBytes: number) {}

  add(number: number, text: string): void {
    const bytes = byteLength(text) + 1
    this.lines.push({ number, text, bytes })
    this.bytes += bytes
    while (this.bytes > this.maxBytes && this.lines.length > 1) {
      this.bytes -= this.lines.shift()?.bytes ?? 0
      this.dropped = true
    }
  }

  result(): Excerpt {
    const first = this.lines[0]
    const last = this.lines.at(-1)
    if (first === undefined || last === undefined) return { text: '', more: false }
    return { fromLine: first.number, toLine: last.number, text: this.lines.map(line => line.text).join('\n'), more: this.dropped }
  }
}

/** Bytes that emitting these numbered lines takes, with room for one separator. */
function cost(lines: readonly { readonly number: number; readonly text: string }[]): number {
  return lines.reduce((sum, line) => sum + byteLength(`${line.number}: ${line.text}`) + 1, 0) + 3
}

/** Matching lines with context, in log order, until the byte budget is spent. */
class SearchWindow {
  private readonly before: { readonly number: number; readonly text: string }[] = []
  private readonly out: string[] = []
  private bytes = 0
  private after = 0
  private last = 0
  private first: number | undefined
  private matches = 0
  private full = false

  constructor(private readonly terms: readonly string[], private readonly context: number, private readonly maxBytes: number) {}

  add(number: number, text: string): void {
    const lower = text.toLowerCase()
    const hit = this.terms.some(term => lower.includes(term))
    if (hit) this.matches += 1
    if (this.full) return
    if (hit) {
      // Leading context gives way first, so the matching line itself fits whenever it can.
      const context = this.before.filter(line => line.number > this.last)
      while (context.length > 0 && this.bytes + cost([...context, { number, text }]) > this.maxBytes) context.shift()
      for (const line of context) this.emit(line.number, line.text)
      this.before.length = 0
      this.emit(number, text)
      this.after = this.context
      return
    }
    if (this.after > 0) {
      this.after -= 1
      this.emit(number, text)
      return
    }
    this.before.push({ number, text })
    if (this.before.length > this.context) this.before.shift()
  }

  private emit(number: number, text: string): void {
    if (this.full || number <= this.last) return
    const separator = this.last !== 0 && number > this.last + 1 ? '--' : undefined
    let line = `${number}: ${text}`
    let bytes = byteLength(line) + 1 + (separator === undefined ? 0 : 3)
    if (this.bytes + bytes > this.maxBytes) {
      if (this.out.length > 0) {
        this.full = true
        return
      }
      // The first line is always returned, cut so the excerpt stays within the limit.
      line = capLine(line, this.maxBytes - 1)
      bytes = byteLength(line) + 1
    }
    if (separator !== undefined) this.out.push(separator)
    this.out.push(line)
    this.bytes += bytes
    this.first ??= number
    this.last = number
  }

  result(): Excerpt {
    return {
      ...this.first === undefined ? {} : { fromLine: this.first, toLine: this.last },
      text: this.out.join('\n'),
      more: this.full,
      matches: this.matches,
    }
  }
}
