import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Item, Session, SessionState, Viewing } from '../types'

const DESK = 'desk'
const VIEWER = 'viewer'
const HEARTBEAT_MS = 15_000
const SCAN_MS = 4_000
const STALE_MS = 45_000

const sessions = atom({ plugin: 'desk', key: 'sessions' } as const, [])
const self = atom({ plugin: 'desk', key: 'self' } as const, '')
const note = atom({ plugin: 'desk', key: 'note' } as const, '')
const expanded = atom({ plugin: 'desk', key: 'expanded' } as const, [])
const tabs = atom({ plugin: 'desk', key: 'tabs' } as const, {})
const tick = atom({ plugin: 'desk', key: 'tick' } as const, 0)
const hidden = atom({ plugin: 'desk', key: 'hidden' } as const, [])
const viewing = atom({ plugin: 'desk', key: 'viewing' } as const, null)

// what the person has to do, most urgent first
const ORDER: SessionState[] = ['permission', 'question', 'done', 'working', 'idle']
const WAITING: SessionState[] = ['permission', 'question', 'done']
const LABEL: Record<SessionState, string> = {
  permission: 'needs permission',
  question: 'asked a question',
  done: 'finished',
  working: 'working',
  idle: 'idle',
}

let home = ''
let tty: string | null = null
let isTitled = true
let isBriefing = false
let titleAt = 0
let tabsAt = 0
let bindAt = 0
let bindTries = 0
let lastSig = ''
let lastTabs = ''
let me: Session | null = null

const waiting = (list: Session[]) => list.filter(s => WAITING.includes(s.state))

const ago = (since: number) => {
  const m = Math.floor((Date.now() - since) / 60_000)

  return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h`
}

const snippet = (text: string, n = 90) => {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

const dir = () => `${home}/.claude/desk/sessions`

const ICON: Record<SessionState, string> = {
  permission: '🔴',
  question: '🟠',
  done: '🟢',
  working: '⏳',
  idle: '⚪',
}

// a tab title is an OSC 2 sequence written to a terminal's own device
async function paint($: EngineInterface, device: string, text: string) {
  await $.process.run(['sh', '-c', 'printf "\\033]2;%s\\007" "$1" > "/dev/$2"', '_', text, device])
}

const name = (s: Session) => s.custom || s.label || s.title || s.project

const tabText = (s: Session) => `${ICON[s.state]} ${snippet(name(s), 40)}`

const threeWords = (text: string) =>
  text
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')

// the session's name: the last title entry in its transcript, one you set winning over the generated one
async function refreshTitle($: EngineInterface) {
  if (me === null || Date.now() - titleAt < 10_000) {
    return
  }
  titleAt = Date.now()
  const folder = me.cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const file = `${home}/.claude/projects/${folder}/${me.id}.jsonl`
  const found = await $.process.run([
    'sh', '-c', 'grep -E \'"type":"[a-z-]*title"\' "$1" | tail -n 40', '_', file,
  ])
  let custom = ''
  let generated = ''
  for (const line of found.stdout.split('\n')) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      const value = Object.entries(row).find(
        ([key, v]) => key !== 'type' && key !== 'sessionId' && typeof v === 'string',
      )?.[1] as string | undefined
      if (value) {
        if (String(row.type) === 'ai-title') {
          generated = value
        } else {
          custom = value
        }
      }
    } catch {
      // not a title row
    }
  }
  me = { ...me, custom, title: generated || me.title }
}

async function retitle($: EngineInterface) {
  if (me === null || tty === null || !isTitled) {
    return
  }
  await paint($, tty, tabText(me))
}

async function osa($: EngineInterface, lines: string[], args: string[] = []) {
  return $.process.run(['osascript', ...lines.flatMap(l => ['-e', l]), ...args], { timeoutMs: 8000 })
}

type Terminal = { id: string; wd: string; name: string }

// every Ghostty terminal: its id, working directory and the title it shows now
async function listTerminals($: EngineInterface) {
  const ran = await osa($, [
    'tell application "Ghostty"',
    'set out to ""',
    'repeat with t in terminals',
    'set out to out & (id of t) & (ASCII character 9) & (working directory of t) & (ASCII character 9) & (name of t) & (ASCII character 10)',
    'end repeat',
    'return out',
    'end tell',
  ])
  const list: Terminal[] = []
  if (ran.exitCode === 0) {
    for (const line of ran.stdout.split('\n')) {
      const [id = '', wd = '', ...rest] = line.split('\t')
      if (id) {
        list.push({ id, wd, name: rest.join('\t').trim() })
      }
    }
  }

  return list
}

// find this session's Ghostty terminal: by folder, then by name, and by a quick marker title if those cannot tell
async function bind($: EngineInterface) {
  if (me === null || tty === null || me.term) {
    return
  }
  const dirOf = (path: string) => path.toLowerCase().replace(/\/+$/, '')
  const here = dirOf(me.cwd)
  const names = [name(me), me.title].filter(Boolean).map(n => n.toLowerCase())
  const guess = async () => {
    const near = (await listTerminals($)).filter(t => dirOf(t.wd) === here)
    const named = near.filter(t => names.some(n => t.name.toLowerCase().includes(n)))

    return named.length === 1 ? named[0] : near.length === 1 ? near[0] : undefined
  }
  let found = await guess()
  if (found === undefined) {
    const marker = `desk-bind-${me.id.slice(0, 8)}`
    for (let i = 0; i < 4 && found === undefined; i += 1) {
      await paint($, tty, marker)
      await $.clock.sleep(150)
      found = (await listTerminals($)).find(t => t.name === marker)
    }
    await paint($, tty, tabText(me))
  }
  if (found !== undefined && me !== null) {
    me = { ...me, term: found.id }
    await save($)
  }
}

// focus a session's tab, and with `text` paste it into that prompt without sending; returns an error or ''
async function reach($: EngineInterface, s: Session, text = ''): Promise<string> {
  const paste = text ? ['input text (item 2 of argv) to t'] : []
  const script = (by: string) => [
    'on run argv',
    'tell application "Ghostty"',
    `set t to first terminal whose ${by} is (item 1 of argv)`,
    'focus t',
    ...paste,
    'end tell',
    'end run',
  ]
  const flat = text.replace(/\s+/g, ' ')
  if (s.term) {
    const ran = await osa($, script('id'), [s.term, flat])

    return ran.exitCode === 0 ? '' : snippet(ran.stderr, 100)
  }
  if (!s.tty) {
    return 'no terminal known for this session'
  }
  // not bound yet: mark the tab, focus it by the mark, put its title back
  const marker = `desk-focus-${s.id.slice(0, 8)}`
  await paint($, s.tty, marker)
  await $.clock.sleep(400)
  const ran = await osa($, script('name'), [marker, flat])
  await paint($, s.tty, tabText(s))

  return ran.exitCode === 0 ? '' : snippet(ran.stderr, 100)
}

// a short message for the pane's top line; the chat never gets one
async function tell($: EngineInterface, text: string) {
  await update($, note, () => text)
  $.clock.after(8_000, () => void update($, note, current => (current === text ? '' : current)))
}

async function openSession($: EngineInterface, s: Session) {
  const error = await reach($, s)
  if (error) {
    await tell($, `Could not open ${name(s)}: ${error}`)
  }
}

async function save($: EngineInterface) {
  if (me === null) {
    return
  }
  me = { ...me, updatedAt: Date.now() }
  await refreshTitle($)
  await $.fs.write(`${dir()}/${me.id}.json`, JSON.stringify(me))
  await retitle($)
}

async function setState($: EngineInterface, state: SessionState, detail = '', prompt?: string) {
  if (me === null) {
    return
  }
  const changed = me.state !== state
  me = {
    ...me,
    state,
    detail,
    prompt: prompt ?? me.prompt,
    since: changed ? Date.now() : me.since,
  }
  await save($)
}

async function scan($: EngineInterface) {
  let names: string[] = []
  try {
    names = (await $.fs.list(dir())).map(entry => entry.name).filter(name => name.endsWith('.json'))
  } catch {
    // the folder does not exist until a session has written
  }

  if (me !== null) {
    try {
      const notes = (await $.fs.list(`${home}/.claude/desk/commands`)).filter(n => n.name.startsWith(`${me?.id}-`))
      for (const note of notes) {
        const path = `${home}/.claude/desk/commands/${note.name}`
        try {
          const { itemId } = JSON.parse((await $.fs.read(path)) as string) as { itemId: string }
          await dismissOwn($, itemId)
        } catch {
          // a half-written note: the next scan has it
        }
        void $.process.run(['rm', '-f', path])
      }
    } catch {
      // no notes folder yet
    }
  }

  const now = Date.now()
  const found: Session[] = []
  for (const name of names) {
    try {
      const one = JSON.parse((await $.fs.read(`${dir()}/${name}`)) as string) as Session & { ended?: boolean }
      const age = now - one.updatedAt
      if (one.ended || age > STALE_MS) {
        if (age > STALE_MS * 4) {
          void $.process.run(['rm', '-f', `${dir()}/${name}`])
        }
        continue
      }
      found.push(one)
    } catch {
      // half-written file: the next scan has it
    }
  }

  const id = await $.session.id()
  // a fixed order: when the session began, never its state
  found.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || a.id.localeCompare(b.id))
  // a write redraws the pane: write only when something it shows has changed
  const sig = JSON.stringify(found, (key, value) => (key === 'updatedAt' ? undefined : value))
  if (sig !== lastSig) {
    lastSig = sig
    await update($, sessions, () => found)
  }
  if ((await read($, self)) !== id) {
    await update($, self, () => id)
  }

  if (me !== null) {
    if (!me.term && tty !== null && bindTries < 6 && Date.now() - bindAt > 30_000) {
      bindTries += 1
      bindAt = Date.now()
      void bind($)
    }
    // Claude can write the title between our updates: write it again so the tab keeps up with the pane
    await retitle($)
    const isPaneUp = (await $.ui.panes()).some(pane => pane.id === DESK && pane.isPlaced)
    if (isPaneUp && Date.now() - tabsAt > 6000) {
      tabsAt = Date.now()
      const map: Record<string, string> = {}
      for (const t of await listTerminals($)) {
        map[t.id] = t.name
      }
      const mapSig = JSON.stringify(map)
      if (mapSig !== lastTabs) {
        lastTabs = mapSig
        await update($, tabs, () => map)
      }
    }
  }
}

const BRIEF_PROMPT =
  'Below is the recent conversation of a Claude Code session. Reply in this exact format:\n' +
  'LABEL: at most three plain words naming the work happening now, like "Tab title design".\n' +
  'BRIEF: one or two plain sentences saying what the person is trying to get done and what ' +
  'just happened or is next. Plain words, no jargon, no markdown, under 40 words.\n' +
  'ITEMS: then up to five lines, each starting with "- QUESTION:" or "- ACTION:". ' +
  'Use QUESTION only when Claude is genuinely waiting on the person for an answer or a decision, ' +
  'never for rhetorical questions, offers or things Claude can decide itself. ' +
  'Use ACTION only for something the person still has to do or decide. ' +
  'Each under 15 words, plain wording. List only what is still open now; leave out anything ' +
  'already answered or done. If there is nothing open, write "- none".\n' +
  'Keep the previous LABEL, and the wording of previous items that are still open, unless things have clearly changed.'

const idOf = (text: string) => {
  let h = 5381
  for (const c of text.toLowerCase().replace(/[^a-z0-9]/g, '')) {
    h = ((h * 33) ^ c.charCodeAt(0)) >>> 0
  }

  return h.toString(36)
}

// the person removed it, or acted on it: it is gone and the next summary may not bring it back
async function dismissOwn($: EngineInterface, itemId: string) {
  if (me === null) {
    return
  }
  me = {
    ...me,
    items: me.items.filter(i => i.id !== itemId),
    dismissed: [...me.dismissed.filter(x => x !== itemId), itemId].slice(-60),
  }
  await save($)
}

async function dismiss($: EngineInterface, s: Session, item: Item) {
  await update($, hidden, list => [...list, item.id].slice(-200))
  if (me !== null && s.id === me.id) {
    await dismissOwn($, item.id)

    return
  }
  // another session owns its record: leave it a note it reads on its next scan
  await $.fs.write(`${home}/.claude/desk/commands/${s.id}-${Date.now()}.json`, JSON.stringify({ itemId: item.id }))
}

// act on an item: a draft in that session's prompt box, not sent
async function actOn($: EngineInterface, s: Session, item: Item) {
  const draft =
    item.kind === 'question' ? `${item.text} My answer: ` : `Let's take care of this: ${item.text}`
  if (me !== null && s.id === me.id) {
    await $.prompt.fill({ text: draft, mode: 'replace' })
    await dismiss($, s, item)

    return
  }
  const error = await reach($, s, draft)
  if (error) {
    await tell($, `Could not open ${name(s)}: ${error}`)

    return
  }
  await dismiss($, s, item)
}

// one small-model call over the recent conversation; the answer is the session's brief
async function refreshBrief($: EngineInterface) {
  if (me === null || isBriefing) {
    return ''
  }
  isBriefing = true
  try {
    const messages = await $.session.messages()
    const recent = messages
      .slice(-14)
      .map(m => `${m.role}: ${snippet(String(m.text ?? ''), 500)}`)
      .join('\n')
    if (recent === '') {
      return ''
    }
    const previous = `${me.label ? `Previous LABEL: ${me.label}\n` : ''}${me.brief ? `Previous BRIEF: ${me.brief}\n` : ''}${me.items.length ? `Previous ITEMS:\n${me.items.map(i => `- ${i.kind.toUpperCase()}: ${i.text}`).join('\n')}\n` : ''}\n`
    const reply = await $.model.complete({
      model: 'haiku',
      prompt: `${BRIEF_PROMPT}\n\n${previous}${recent}`,
      maxTokens: 160,
    })
    if (!reply.isAnswered) {
      return ''
    }
    const raw = reply.text
    const at = raw.search(/^ITEMS:/im)
    const head = at >= 0 ? raw.slice(0, at) : raw
    const tail = at >= 0 ? raw.slice(at) : ''
    const said = /^LABEL:\s*(.+)$/im.exec(head)?.[1] ?? ''
    const text = snippet(/^BRIEF:\s*([\s\S]+)$/im.exec(head)?.[1] ?? head, 600)
    let items = me.items
    if (tail !== '') {
      const seen = new Set<string>()
      items = []
      for (const [, kind = '', body = ''] of tail.matchAll(/^\s*-\s*(QUESTION|ACTION):\s*(.+)$/gim)) {
        const itemText = snippet(body, 110)
        const id = idOf(itemText)
        if (!me.dismissed.includes(id) && !seen.has(id)) {
          seen.add(id)
          items.push({ id, kind: kind.toUpperCase() === 'QUESTION' ? 'question' : 'action', text: itemText })
        }
      }
      items = items.slice(0, 6)
    }
    me = { ...me, brief: text, label: threeWords(said) || me.label, items }
    await save($)

    return text
  } catch {
    return ''
  } finally {
    isBriefing = false
  }
}

const summarize = (tool: string, input: unknown) => {
  const i = (input ?? {}) as Record<string, unknown>
  const detail = i.command ?? i.file_path ?? i.path ?? i.url ?? i.pattern ?? ''
  const first = String(detail).split('\n')[0]?.split(' <<')[0] ?? ''

  return `${tool}${first ? `: ${snippet(first, 80)}` : ''}`
}

const IMAGE = /\.(png|jpe?g|gif|webp|heic|tiff?|bmp|pdf)$/i
const MARKDOWN = /\.(md|markdown)$/i
const LANGUAGE: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', json: 'json', py: 'python',
  go: 'go', html: 'html', css: 'css', yaml: 'yaml', yml: 'yaml', sh: 'bash', sql: 'sql',
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    home = (await $.process.run(['printenv', 'HOME'])).stdout.trim()
    const cwd = await $.session.cwd()
    const id = await $.session.id()
    me = {
      id,
      project: cwd.split('/').filter(Boolean).pop() ?? cwd,
      startedAt: Date.now(),
      title: '',
      custom: '',
      label: '',
      tty: '',
      term: '',
      cwd,
      state: 'idle',
      detail: '',
      prompt: '',
      brief: '',
      items: [],
      dismissed: [],
      since: Date.now(),
      updatedAt: Date.now(),
    }
    try {
      const old = JSON.parse((await $.fs.read(`${dir()}/${id}.json`)) as string) as Session
      me = { ...me, startedAt: old.startedAt || me.startedAt, brief: old.brief ?? '', prompt: old.prompt ?? '', title: old.title ?? '', custom: old.custom ?? '', label: old.label ?? '', items: old.items ?? [], dismissed: old.dismissed ?? [], term: old.term ?? '' }
    } catch {
      // a new session has no file yet
    }
    const found = (await $.process.run(['sh', '-c', 'ps -o tty= -p $PPID'])).stdout.trim()
    tty = found && found !== '??' ? found : null
    me = { ...me, tty: tty ?? '' }
    await save($)
    void bind($)
    await $.command.register({ name: 'whereami', description: 'Refresh the one-line summary of where this session stands' })
    await $.command.register({ name: 'tabtitle', description: 'Turn the tab title status (on/off); no argument shows which' })
    await $.command.register({ name: 'desk', description: 'Open the desk: every Claude session and what it is waiting on' })
    await $.command.register({ name: 'view', description: 'View a file or image in a pane (no argument: newest screenshot)' })
    void $.ui.open({ id: DESK, title: 'Desk' })
    void scan($)
    $.clock.every(HEARTBEAT_MS, () => void save($))
    $.clock.every(SCAN_MS, () => void scan($))
    $.clock.every(60_000, () => void update($, tick, n => n + 1))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (me !== null) {
      await $.fs.write(`${dir()}/${me.id}.json`, JSON.stringify({ ...me, ended: true, updatedAt: Date.now() }))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const isSystem = /^\s*</.test(e.text)
    await setState($, 'working', '', isSystem ? undefined : snippet(e.text))

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion') {
      await setState($, 'question', snippet(e.questions[0]?.question ?? ''))
      const ran = await next(e)
      await setState($, 'working')

      return ran
    }

    // a tool running means any permission or question before it is answered
    if (me !== null && me.state !== 'working') {
      await setState($, 'working')
    }

    return next(e)
  })

  // a verdict of ask is the permission prompt about to show; a query has no tool_use_id
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined && e.tool !== 'AskUserQuestion') {
      await setState($, 'permission', summarize(e.tool, e.input))
    }

    return verdict
  })

  on('turn.complete', async ($, e, next) => {
    if (me !== null && me.state !== 'done') {
      await setState($, 'done')
    }
    if (e.agentId === undefined && e.reason === 'answer') {
      void refreshBrief($)
    }

    return next(e)
  })

  on('command.run', { command: 'whereami' }, async $ => {
    const text = await refreshBrief($)

    return { text: text || 'No brief yet: nothing to summarize, or the model did not answer.' }
  })

  on('command.run', { command: 'tabtitle' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'on' || arg === 'off') {
      isTitled = arg === 'on'
      await retitle($)
    }

    return { text: `Tab title: ${isTitled ? 'on' : 'off'} (terminal ${tty ?? 'not found'}).` }
  })

  on('command.run', { command: 'desk' }, async $ => {
    await scan($)
    const opened = await $.ui.open({ id: DESK, title: 'Desk' })

    return { text: opened.isPlaced ? 'Desk opened.' : 'The pane needs a wider terminal (110 columns).' }
  })

  on('command.run', { command: 'view' }, async ($, e) => {
    const cwd = await $.session.cwd()
    let arg = e.args.trim()

    if (arg === '') {
      const desktop = `${home}/Desktop`
      const ls = await $.process.run(['ls', '-t', desktop])
      const shot = ls.stdout.split('\n').find(name => /^Screenshot/i.test(name))
      if (!shot) {
        return { text: 'No screenshot on the Desktop; pass a path.' }
      }
      arg = `${desktop}/${shot}`
    }

    const path = arg.startsWith('/') ? arg : arg.startsWith('~/') ? `${home}${arg.slice(1)}` : `${cwd}/${arg}`
    let next: Viewing

    try {
      if (IMAGE.test(path)) {
        const cache = `${home}/.cache/desk-view`
        await $.process.run(['mkdir', '-p', cache])
        const file = `${cache}/${Date.now()}.png`
        const made = await $.process.run(['sips', '-s', 'format', 'png', path, '--out', file])
        if (made.exitCode !== 0) {
          throw new Error(made.stderr.trim() || 'could not convert the image')
        }
        const dims = await $.process.run(['sips', '-g', 'pixelWidth', '-g', 'pixelHeight', file])
        const width = Number(/pixelWidth: (\d+)/.exec(dims.stdout)?.[1] ?? 0)
        const height = Number(/pixelHeight: (\d+)/.exec(dims.stdout)?.[1] ?? 0)
        next = { kind: 'image', path, file, width, height }
      } else {
        const text = (await $.fs.read(path)) as string
        const ext = path.split('.').pop()?.toLowerCase() ?? ''
        next = MARKDOWN.test(path)
          ? { kind: 'markdown', path, text: text.slice(0, 60_000) }
          : { kind: 'code', path, text: text.slice(0, 60_000), language: LANGUAGE[ext] ?? '' }
      }
    } catch (error) {
      next = { kind: 'error', path, message: String(error) }
    }

    await update($, viewing, () => next)
    const opened = await $.ui.open({ id: VIEWER, title: path.split('/').pop() ?? 'View' })

    return { text: opened.isPlaced ? `Viewing ${path}` : 'The pane needs a wider terminal (110 columns).' }
  })

  on('ui.render', { component: 'Pane', requestId: DESK }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const all = await read($, sessions)
    const id = await read($, self)
    const gone = await read($, hidden)
    const open = await read($, expanded)
    const seen = await read($, tabs)
    const said = await read($, note)
    await read($, tick)
    const columns = e.viewport?.columns ?? 60
    const rows = e.viewport?.rows ?? 30
    const need = waiting(all.filter(s => s.id !== id)).length
    const rule = '─'.repeat(250)
    const inner = Math.max(30, columns - 18)

    // every session takes the same rows: a header, a two-line brief, then what it is blocked on and its items
    const block = all.map(s => {
      const mine = (s.items ?? []).filter(i => !gone.includes(i.id))
      const isOpen = open.includes(s.id)
      const shown = isOpen ? mine : mine.slice(0, 3)
      const isBlocked = (s.state === 'permission' || s.state === 'question') && Boolean(s.detail)
      const text = s.brief || (s.prompt && !s.prompt.startsWith('<') ? `Asked: ${s.prompt}` : '')
      const lines = Math.max(1, Math.ceil(text.length / inner))
      const extras = (isBlocked ? 1 : 0) + shown.length + (mine.length > 3 ? 1 : 0)
      const differs = Boolean(s.term) && seen[s.term] !== undefined && seen[s.term] !== tabText(s)
      const height = 2 + (differs ? 1 : 0) + lines + extras + (s.id === id ? 2 : 0) + (extras > 0 ? 1 : 0)

      return { s, mine, isOpen, shown, isBlocked, differs, height }
    })
    let used = 2
    const fits = block.filter(b => (used += b.height) <= rows)
    const hiddenCount = block.length - fits.length

    return (
      <Box flexDirection="column">
        <Text bold>
          {all.length} sessions · {need} waiting on you
        </Text>
        {said !== '' && <Text color="yellow">{said}</Text>}
        {all.length === 0 && <Text dimColor>No sessions reporting yet.</Text>}
        {fits.map(({ s, mine, isOpen, shown, isBlocked, differs }) => {
          const color = s.state === 'permission' || s.state === 'question' ? 'yellow' : s.state === 'done' ? 'green' : undefined

          return (
            <Box key={s.id} flexDirection="column">
              <Box height={1} overflow="hidden">
                <Text dimColor wrap="wrap">{rule}</Text>
              </Box>
              <Box
                flexDirection="column"
                borderStyle={s.id === id ? 'round' : undefined}
                borderColor={s.id === id ? 'cyan' : undefined}
                paddingX={s.id === id ? 0 : 1}
              >
              <Box justifyContent="space-between">
                <Box flexGrow={1} flexShrink={1}>
                  <Text bold color={color} wrap="truncate-end">
                    {ICON[s.state]} {name(s)}
                  </Text>
                </Box>
                <Box flexShrink={0} paddingLeft={2}>
                  <Text dimColor>
                    {s.project} · {s.state === 'idle' ? '' : `${LABEL[s.state]} · `}{ago(s.since)}{'  '}
                  </Text>
                  {s.id === id ? (
                    <Text bold color="cyan">you are here</Text>
                  ) : (
                    <Button key={`go-${s.id}`} label="Go To" onPress={() => void openSession($, s)} />
                  )}
                </Box>
              </Box>
              {differs && (
                <Box paddingLeft={3}>
                  <Text color="yellow" wrap="truncate-end">
                    tab: {seen[s.term]}
                  </Text>
                </Box>
              )}
              <Box paddingLeft={3}>
                {s.brief || (s.prompt && !s.prompt.startsWith('<')) ? (
                  <Text wrap="wrap">{s.brief || `Asked: ${s.prompt}`}</Text>
                ) : (
                  <Text dimColor>No summary yet; it appears after the first finished turn.</Text>
                )}
              </Box>
              {(isBlocked || shown.length > 0) && <Text> </Text>}
              {isBlocked && (
                <Box paddingLeft={3}>
                  <Text color="yellow" wrap="truncate-end">→ {s.detail}</Text>
                </Box>
              )}
              {shown.map(i => (
                <Box key={i.id} paddingLeft={3} justifyContent="space-between">
                  <Box flexGrow={1} flexShrink={1} paddingRight={1}>
                    <Text color={i.kind === 'question' ? 'yellow' : undefined} wrap="truncate-end">
                      {i.kind === 'question' ? '?' : '☐'} {i.text}
                    </Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Button key={`act-${s.id}-${i.id}`} label={i.kind === 'question' ? 'Reply' : 'Do it'} onPress={() => void actOn($, s, i)} />
                    <Button key={`rm-${s.id}-${i.id}`} label="✕" onPress={() => void dismiss($, s, i)} />
                  </Box>
                </Box>
              ))}
              {mine.length > 3 && (
                <Box paddingLeft={3}>
                  <Button
                    key={`more-${s.id}`}
                    label={isOpen ? 'show fewer' : `+${mine.length - 3} more`}
                    onPress={() =>
                      void update($, expanded, list =>
                        list.includes(s.id) ? list.filter(x => x !== s.id) : [...list, s.id],
                      )
                    }
                  />
                </Box>
              )}
              </Box>
            </Box>
          )
        })}
        {hiddenCount > 0 && <Text dimColor>+{hiddenCount} more sessions below; widen or heighten the pane</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: VIEWER }, async ($, e) => {
    const { Box, Code, Markdown, Text } = $.ui.resolve(e)
    const v = await read($, viewing)
    const columns = Math.max(20, (e.viewport?.columns ?? 100) - 4)
    const rows = Math.max(5, (e.viewport?.rows ?? 30) - 4)

    if (v === null) {
      return <Text dimColor>Nothing to view. Use /view &lt;path&gt;.</Text>
    }
    if (v.kind === 'error') {
      return <Text color="red">{v.path}: {v.message}</Text>
    }
    if (v.kind === 'markdown') {
      return <Markdown text={v.text} />
    }
    if (v.kind === 'code') {
      return <Code source={v.text} language={v.language || undefined} path={v.path} />
    }

    if (e.surface !== 'terminal') {
      return <Text dimColor>Images show in the terminal only.</Text>
    }
    const { Image } = $.ui.resolve(e)

    // a terminal cell is about twice as tall as wide
    const ratio = v.height / Math.max(1, v.width) / 2
    let cols = columns
    let imgRows = Math.max(1, Math.round(cols * ratio))
    if (imgRows > rows) {
      imgRows = rows
      cols = Math.max(1, Math.round(imgRows / ratio))
    }

    return (
      <Box flexDirection="column">
        <Text dimColor>{v.path} · {v.width}×{v.height}</Text>
        <Image source={{ file: v.file, format: 'png' }} columns={Math.min(255, cols)} rows={Math.min(255, imgRows)} alt={v.path} />
      </Box>
    )
  })
}
