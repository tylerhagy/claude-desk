export type SessionState = 'permission' | 'question' | 'done' | 'working' | 'idle'

export type Item = { id: string; kind: 'question' | 'action'; text: string }

export type Session = {
  id: string
  project: string
  startedAt: number
  title: string
  custom: string
  label: string
  tty: string
  term: string
  cwd: string
  state: SessionState
  detail: string
  prompt: string
  brief: string
  items: Item[]
  dismissed: string[]
  since: number
  updatedAt: number
}

export type Viewing =
  | { kind: 'image'; path: string; file: string; width: number; height: number }
  | { kind: 'markdown'; path: string; text: string }
  | { kind: 'code'; path: string; text: string; language: string }
  | { kind: 'error'; path: string; message: string }

declare module 'claude-code' {
  interface PluginState {
    desk: { sessions: Session[]; self: string; note: string; only: boolean; expanded: string[]; hidden: string[]; tabs: Record<string, string>; tick: number; viewing: Viewing | null }
  }
}
