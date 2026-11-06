import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Coaching, LogEntry } from '../types'

const MODEL = 'haiku'
const EFFORT = 'low' as const
const ENABLED_KEY = 'enabled' // $.store: survives sessions, per person
const LOG_KEY = 'log' // $.store: the last LOG_SIZE Haiku calls
const LOG_SIZE = 50

const last = atom({ plugin: 'learn-english', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'learn-english', key: 'isHidden' } as const, false)

/** Prompts with no sentence worth coaching: slash commands, shell, memory, and one or two words. */
function isSkipped(text: string): boolean {
  const t = text.trim()
  if (t === '' || t.startsWith('/') || t.startsWith('!') || t.startsWith('#')) return true
  return t.split(/\s+/).length < 3
}

const USAGE = 'Usage: /learn-english [on|off|show|log] (no argument toggles)'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'learn-english',
      description: 'English practice: Haiku corrects each prompt in a band above the prompt. on, off, show, log; no argument toggles',
    })

    return next(e)
  })

  on('command.run', { command: 'learn-english' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const isOn = (await $.store.get(ENABLED_KEY)) === true
    let text: string
    if (arg === '' || arg === 'on' || arg === 'off') {
      const next = arg === '' ? !isOn : arg === 'on'
      await $.store.set(ENABLED_KEY, next)
      if (!next) await update($, last, () => null)
      text = `learn-english is now ${next ? 'on' : 'off'}`
    } else if (arg === 'show') {
      await update($, isHidden, () => false)
      text = (await read($, last)) ? 'Band shown again.' : 'Nothing to show yet: send a prompt first.'
    } else if (arg === 'log') {
      const log = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
      text = log.length === 0
        ? 'No Haiku calls logged yet.'
        : log.slice(-10).map(l =>
            `${l.ts}  ${l.model}/${l.effort}  in ${(l.inputTokens ?? 0) + (l.cacheReadTokens ?? 0) + (l.cacheWriteTokens ?? 0)} (cache read ${l.cacheReadTokens ?? 0})  out ${l.outputTokens ?? 0}  ${l.durationMs} ms  ${l.outcome}  "${l.prompt}"`,
          ).join('\n')
    } else {
      text = USAGE
    }

    return { text, isTextDisplayOnly: true }
  })

  on('prompt.submit', async ($, e, next) => {
    // Coaching never holds up the prompt: any failure here just skips the check.
    try {
      const text = e.text
      const isOn = (await $.store.get(ENABLED_KEY)) === true

      if (isOn && !e.command && !e.isMeta && !isSkipped(text)) {
        await update($, last, () => ({ status: 'checking', prompt: text, text: '' }))
        await update($, isHidden, () => false)
        // Off the prompt's path: the turn starts now, the band fills in when Haiku answers.
        $.clock.after(0, () => {
          void coach($, text)
        })
      }
    } catch {}

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const coaching = await read($, last)
    if (e.props.hasSurvey || coaching === null || coaching.status === 'error' || (await read($, isHidden))) {
      return next(e)
    }

    const { Box, Button, Markdown, Text } = $.ui.resolve(e)
    const header =
      coaching.status === 'checking'
        ? '🇬🇧 English check: checking…'
        : coaching.status === 'ok'
          ? '🇬🇧 English check: ✅ no mistakes'
          : '🇬🇧 English check'

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
        <Box>
          <Text bold color="yellow">{header} </Text>
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {coaching.status === 'done' ? body(Box, Markdown, coaching.text, e.props.bodyColumns) : null}
      </Box>
    )
  })
}

/**
 * Lists (mistakes, useful phrases) with their lead-in line on the right; the quote and any
 * prose explaining it on the left, so the band stays short. Stacked when the band is under
 * 100 cells wide or one side is empty.
 */
function body(Box: any, Markdown: any, text: string, columns: number) {
  const isListLine = (l: string) => /^\s*([-*+]|\d+[.)])\s/.test(l)
  const left: string[] = []
  const right: string[] = []
  const blocks = text.split(/\n\s*\n/).map(b => b.trim())
  blocks.forEach((block, i) => {
    const isList = block.split('\n').some(isListLine)
    // A lead-in ("Useful phrases:") set apart from its list goes with the list.
    const isLeadIn = block.endsWith(':') && (blocks[i + 1] ?? '').split('\n').some(isListLine)
    ;(isList || isLeadIn ? right : left).push(block)
  })
  const quote = left.join('\n\n')
  const notes = right.join('\n\n')
  if (columns < 100 || quote === '' || notes === '') return <Markdown text={text} />
  // Two equal columns; numeric widths, since the band's Box takes no flexBasis.
  const half = Math.floor((columns - 4 - 2) / 2) // less the border and padding (4), and the gap (2)
  return (
    <Box flexDirection="row" columnGap={2}>
      <Box flexDirection="column" width={half}>
        <Markdown text={quote} />
      </Box>
      <Box flexDirection="column" width={half}>
        <Markdown dimColor text={notes} />
      </Box>
    </Box>
  )
}

async function coach($: EngineInterface, prompt: string) {
  let system = ''
  try {
    system = await $.fs.read(`${$.plugin.root}/coach-prompt.md`)
  } catch {
    await update($, last, () => ({ status: 'error', prompt, text: '' }))
    return
  }

  const started = await $.clock.now()
  const r = await $.model.complete({
    model: MODEL,
    effort: EFFORT,
    system: [{ text: system, cache: true }],
    prompt: `<message>\n${prompt}\n</message>`,
    maxTokens: 1500,
    timeoutMs: 45000,
  })
  const ms = (await $.clock.now()) - started

  // A newer prompt may have started its own check; only the latest one fills the band.
  const current: Coaching | null = await read($, last)
  const answer = r.isAnswered ? r.text.trim() : ''
  let next: Coaching
  if (!r.isAnswered || answer === '' || answer === 'SKIP') {
    next = { status: 'error', prompt, text: '' }
  } else if (answer === 'OK') {
    next = { status: 'ok', prompt, text: '' }
  } else {
    next = { status: 'done', prompt, text: answer }
  }
  if (current?.prompt === prompt) await update($, last, () => next)

  const outcome = !r.isAnswered ? `ERROR:${r.reason}` : answer === '' ? 'EMPTY' : answer === 'SKIP' || answer === 'OK' ? answer : 'CORRECTED'
  const u = r.usage
  const entry: LogEntry = {
    ts: new Date(started).toISOString(),
    model: MODEL,
    effort: EFFORT,
    inputTokens: u?.input_tokens ?? null,
    cacheReadTokens: u?.cache_read_input_tokens ?? null,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? null,
    outputTokens: u?.output_tokens ?? null,
    durationMs: ms,
    outcome,
    prompt: prompt.trim().slice(0, 80),
  }
  const log = ((await $.store.get(LOG_KEY)) as LogEntry[] | undefined) ?? []
  await $.store.set(LOG_KEY, [...log, entry].slice(-LOG_SIZE))
}
