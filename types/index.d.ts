export type Coaching = {
  status: 'checking' | 'done' | 'ok' | 'error'
  prompt: string
  text: string
}

/** One Haiku call, as `/learn-english log` lists it. */
export type LogEntry = {
  ts: string
  model: string
  effort: string
  inputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number | null
  durationMs: number
  outcome: string
  prompt: string
}

declare module 'claude-code' {
  interface PluginState {
    'learn-english': { last: Coaching | null; isHidden: boolean }
  }
}
