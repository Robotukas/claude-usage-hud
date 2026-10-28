import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRow, BgTab, Hud, Limit, Phase, Section, TaskKind, TaskRow, Tokens } from '../types'

const PANE = 'usage-hud'
const zero = (): Tokens => ({ out: 0, fresh: 0, cacheRead: 0, cacheWrite: 0 })
const empty: Hud = { phase: null, main: zero(), mainModel: '', agents: [], workflows: [], tasks: [], limits: [], perPhase: [] }

const hud = atom({ plugin: 'usage-hud', key: 'hud' } as const, empty)
// State survives a reload of the mod, so a value saved by an older version may
// lack newer fields: fill them with defaults before reading or changing it.
const fill = (st: Partial<Hud> | undefined): Hud => ({ ...empty, ...(st ?? {}) })
const upd = ($: Parameters<typeof update>[0], fn: (st: Hud) => Hud) => update($, hud, raw => fn(fill(raw)))
const isFolded = atom({ plugin: 'usage-hud', key: 'isFolded' } as const, false)
const focus = atom({ plugin: 'usage-hud', key: 'focus' } as const, 'phase')
const bgTab = atom({ plugin: 'usage-hud', key: 'bgTab' } as const, 'active')
// Bumped once a second while an agent runs, so elapsed times tick.
const tick = atom({ plugin: 'usage-hud', key: 'tick' } as const, 0)

// "Phase 1/7 ▒□□□□□□□□□ 14% · Data layer (invisible) — checkpoint"
const PHASE_RE = /Phase\s+(\d+)\/(\d+)\s+\S+\s+(\d+)%\s*·\s*([^\n]+)/

export const parsePhase = (text: string): Phase | null => {
  const m = PHASE_RE.exec(text)
  return m ? { n: Number(m[1]), total: Number(m[2]), pct: Number(m[3]), title: (m[4] ?? '').trim() } : null
}

export const fmtTokens = (n: number): string =>
  n < 1000 ? String(n) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(1)}M`

export const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

export const cells = (pct: number, width = 10): string => {
  const on = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '▰'.repeat(on) + '▱'.repeat(width - on)
}

export const split = (pct: number, width = 10): [string, string] => {
  const on = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return ['▰'.repeat(on), '▱'.repeat(width - on)]
}

const limitName = (kind: string) => (kind === 'five_hour' ? '5h' : kind === 'seven_day' ? 'wk' : kind)

const resetLabel = (iso?: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  return d.getTime() - Date.now() > 20 * 3600e3 ? (days[d.getDay()] ?? '') : `${hh}:${mm}`
}

const shortModel = (id: string) =>
  id.replace(/^claude-/, '').replace(/-(\d+)-(\d+).*$/, ' $1.$2').replace(/^./, c => c.toUpperCase())

const add = (t: Tokens, u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): Tokens => ({
  out: t.out + u.output_tokens,
  fresh: t.fresh + u.input_tokens,
  cacheRead: t.cacheRead + u.cache_read_input_tokens,
  cacheWrite: t.cacheWrite + u.cache_creation_input_tokens,
})

const phaseKey = (p: Phase | null) => (p ? `${p.n}/${p.total} · ${p.title}` : 'No phase')

const limitColor = (pct: number) => (pct >= 90 ? 'red' : pct >= 70 ? 'yellow' : 'green')

// The status line's own limit readings win: they are there straight after a reload.
function withLive(st: Hud, live: { rateLimits: readonly Limit[] }): Hud {
  return live.rateLimits.length ? { ...st, limits: live.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt })) } : st
}

const KIND_ICON: Record<string, string> = { shell: '$', agent: '⚙', monitor: '◎', wake: '⏰', workflow: '⛓' }
// The engine's own label for a background task → the kind drawn for it.
const TASK_KIND: Record<string, TaskKind> = { shell: 'shell', subagent: 'agent', monitor: 'monitor', 'MCP task': 'monitor', workflow: 'workflow' }
const kindIcon = (kind: string) => KIND_ICON[kind] ?? '•'

const isActive = (t: TaskRow) => t.status === 'running' || t.status === 'waiting'
const glyph = (t: TaskRow) => (t.kind === 'wake' && isActive(t) ? '⏰' : t.status === 'running' ? '●' : t.status === 'waiting' ? '◷' : t.status === 'done' ? '✓' : t.status === 'killed' ? '■' : '✗')
const glyphColor = (t: TaskRow): 'green' | 'yellow' | 'red' | undefined => (t.status === 'running' ? 'green' : t.status === 'waiting' ? 'yellow' : t.status === 'failed' ? 'red' : undefined)
const head = (text: string, n = 60) => (text.length > n ? text.slice(0, n - 1) + '…' : text)
const clock = (ms: number) => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// A wakeup that is past its time has fired: shown as done without a notification.
const settle = (tasks: TaskRow[], now: number): TaskRow[] =>
  tasks.map(t => (t.kind === 'wake' && t.status === 'waiting' && !t.recurring && t.dueAt && now > t.dueAt + 60_000 ? { ...t, status: 'done', endedAt: t.dueAt } : t))

const upsertTask = (tasks: TaskRow[], row: TaskRow) => [...tasks.filter(t => t.id !== row.id), row].slice(-40)

// <task-notification> bodies: which task ended, how, and the exit code if any.
export const parseNotifications = (text: string) => {
  const out: { taskId?: string; toolUseId?: string; status: string; summary: string; exitCode?: number }[] = []
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1] ?? ''
    const status = /<status>(.*?)<\/status>/.exec(body)?.[1]
    if (!status) continue
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(body)?.[1]?.trim() ?? ''
    const exit = /exit code (\d+)/.exec(summary)?.[1]
    out.push({
      taskId: /<task-id>(.*?)<\/task-id>/.exec(body)?.[1],
      toolUseId: /<tool-use-id>(.*?)<\/tool-use-id>/.exec(body)?.[1],
      status,
      summary,
      exitCode: exit === undefined ? undefined : Number(exit),
    })
  }
  return out
}

const endedStatus = (status: string): TaskRow['status'] =>
  status === 'completed' ? 'done' : status === 'failed' ? 'failed' : 'killed'

// Marks the tasks and background agents a batch of notifications ended.
const applyEnded = (st: Hud, ended: ReturnType<typeof parseNotifications>, now: number): Hud => ({
  ...st,
  tasks: st.tasks.map(t => {
    const hit = ended.find(n => (n.taskId && n.taskId === t.taskId) || (n.toolUseId && n.toolUseId === t.id))
    if (!hit || !isActive(t)) return t
    const status = hit.exitCode !== undefined && hit.exitCode !== 0 ? 'failed' : endedStatus(hit.status)
    return { ...t, status, endedAt: now, exitCode: hit.exitCode }
  }),
  agents: st.agents.map(a => (ended.some(n => n.taskId === a.id) && !a.endedAt ? { ...a, endedAt: now } : a)),
})

// A band row's › opens the pane with that section first.
async function openAt($: EngineInterface, section: Section) {
  await update($, focus, () => section)
  await $.ui.open({ id: PANE, title: 'Usage', focus: true })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The mod may load into a session already doing work (a reload, or
    // /reload-plugins in an older session): adopt what the engine already has.
    const known = await $.agent.list()
    if (known.length) {
      const now = await $.clock.now()
      await upd($, st => ({
        ...st,
        agents: known.reduce<AgentRow[]>(
          (rows, a) =>
            rows.some(r => r.id === a.id)
              ? rows
              : [
                  ...rows,
                  {
                    id: a.id,
                    label: a.description || a.name || a.type,
                    model: '',
                    startedAt: now,
                    endedAt: a.status === 'completed' || a.status === 'failed' || a.status === 'killed' ? now : undefined,
                    tokens: zero(),
                  },
                ],
          st.agents,
        ).slice(-60),
      }))
    }
    $.clock.every(1000, async () => {
      const st = fill(await read($, hud))
      if (st.agents.some(a => !a.endedAt) || st.tasks.some(isActive)) await update($, tick, n => n + 1)
    })
    await $.command.register({ name: 'usage-hud', description: 'Open the Usage pane (phase, limits, session, agents, per phase)' })
    return next(e)
  })

  on('command.run', { command: 'usage-hud' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Usage' })
    return { text: 'Usage pane opened.' }
  })

  on('session.measure', async ($, e, next) => {
    const limits: Limit[] = e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt }))
    await upd($, st => ({ ...st, limits }))
    return next(e)
  })

  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const fromMeta = /name:\s*['"]([^'"]+)['"]/.exec(e.script ?? '')?.[1]
    const name = fromMeta ?? e.name ?? e.title ?? 'workflow'
    const startedAt = await $.clock.now()
    await upd($, st => ({ ...st, workflows: [...st.workflows.filter(w => w.id !== e.tool_use_id), { id: e.tool_use_id, name, startedAt }].slice(-10) }))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (!r.deny && r.agentId) {
      const row: AgentRow = {
        id: r.agentId,
        label: e.description || e.subagentType,
        model: r.model,
        workflowId: e.workflow ? e.tool_use_id : undefined,
        background: e.background && !e.workflow ? true : undefined,
        startedAt: await $.clock.now(),
        tokens: zero(),
      }
      await upd($, st => ({ ...st, agents: [...st.agents.filter(a => a.id !== row.id), row].slice(-60) }))
    }
    return r
  })

  // ---------- Background tasks ----------
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    const taskId = !r.deny && r.result && typeof r.result === 'object' && 'backgroundTaskId' in r.result ? (r.result as { backgroundTaskId?: string }).backgroundTaskId : undefined
    if (e.run_in_background || taskId) {
      const row: TaskRow = {
        id: e.tool_use_id,
        taskId,
        kind: 'shell',
        label: e.description || head(e.command, 50),
        detail: head(e.command, 80),
        status: 'running',
        startedAt: await $.clock.now(),
      }
      await upd($, st => ({ ...st, tasks: upsertTask(st.tasks, row) }))
    }
    return r
  })

  on('tool.call', { tool: 'Monitor' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.deny) {
      const taskId = r.result && typeof r.result === 'object' && 'taskId' in r.result ? (r.result as { taskId?: string }).taskId : undefined
      const row: TaskRow = {
        id: e.tool_use_id,
        taskId,
        kind: 'monitor',
        label: e.description,
        detail: e.command ? head(e.command, 80) : undefined,
        status: 'waiting',
        startedAt: await $.clock.now(),
      }
      await upd($, st => ({ ...st, tasks: upsertTask(st.tasks, row) }))
    }
    return r
  })

  on('tool.call', { tool: 'ScheduleWakeup' }, async ($, e, next) => {
    const r = await next(e)
    const now = await $.clock.now()
    if (e.stop) {
      await upd($, st => ({ ...st, tasks: st.tasks.map(t => (t.kind === 'wake' && isActive(t) ? { ...t, status: 'killed' as const, endedAt: now } : t)) }))
    } else if (!r.deny) {
      const due = r.result && typeof r.result === 'object' && 'scheduledFor' in r.result ? (r.result as { scheduledFor?: number }).scheduledFor : undefined
      const row: TaskRow = {
        id: e.tool_use_id,
        kind: 'wake',
        label: e.reason || head(e.prompt ?? 'wakeup', 50),
        status: 'waiting',
        startedAt: now,
        dueAt: due ?? now + (e.delaySeconds ?? 0) * 1000,
      }
      // One pending wakeup at a time: a new one replaces the last.
      await upd($, st => ({ ...st, tasks: upsertTask(st.tasks.filter(t => !(t.kind === 'wake' && t.status === 'waiting' && !t.recurring)), row) }))
    }
    return r
  })

  on('tool.call', { tool: 'CronCreate' }, async ($, e, next) => {
    const r = await next(e)
    if (!r.deny) {
      const res = r.result && typeof r.result === 'object' ? (r.result as { id?: string; humanSchedule?: string; recurring?: boolean; nextFireAt?: number }) : {}
      const row: TaskRow = {
        id: e.tool_use_id,
        taskId: res.id,
        kind: 'wake',
        label: head(e.prompt, 50),
        detail: res.humanSchedule ?? e.cron,
        status: 'waiting',
        startedAt: await $.clock.now(),
        dueAt: res.nextFireAt,
        recurring: res.recurring ?? e.recurring ?? false,
      }
      await upd($, st => ({ ...st, tasks: upsertTask(st.tasks, row) }))
    }
    return r
  })

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const r = await next(e)
    const id = e.task_id ?? e.shell_id
    if (!r.deny && id) {
      const now = await $.clock.now()
      await upd($, st => ({
        ...st,
        tasks: st.tasks.map(t => (t.taskId === id && isActive(t) ? { ...t, status: 'killed' as const, endedAt: now } : t)),
        agents: st.agents.map(a => (a.id === id && !a.endedAt ? { ...a, endedAt: now } : a)),
      }))
    }
    return r
  })

  // A task's end arrives as a <task-notification> delivery: into a running turn
  // (session.receive) or as a turn of its own (prompt.submit). Hook both.
  on('session.receive', async ($, e, next) => {
    if (e.text.includes('<task-notification>')) {
      const ended = parseNotifications(e.text)
      if (ended.length) {
        const now = await $.clock.now()
        await upd($, st => applyEnded(st, ended, now))
      }
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.text.includes('<task-notification>')) {
      const ended = parseNotifications(e.text)
      if (ended.length) {
        const now = await $.clock.now()
        await upd($, st => applyEnded(st, ended, now))
      }
    }
    return next(e)
  })

  // Safety net: at every Stop the engine lists what is still in flight; a tracked
  // task missing from that list has ended, even if its notification was missed.
  on('classic.Stop', async ($, e, next) => {
    const live = e.background_tasks
    if (Array.isArray(live)) {
      const ids = new Set(live.map(t => t.id))
      const now = await $.clock.now()
      await upd($, st => {
        // Close what the engine no longer lists…
        let tasks = st.tasks.map(t =>
          t.kind !== 'wake' && isActive(t) && t.taskId && !ids.has(t.taskId) ? { ...t, status: 'done' as const, endedAt: now } : t,
        )
        // …and adopt what it lists that this mod never saw start.
        for (const task of live) {
          if (tasks.some(t => t.taskId === task.id || t.id === task.id)) continue
          tasks = upsertTask(tasks, {
            id: task.id,
            taskId: task.id,
            kind: TASK_KIND[task.type] ?? 'shell',
            label: task.description || task.name || task.command || task.type,
            detail: task.command ? head(task.command, 80) : task.agent_type,
            status: task.status === 'failed' ? 'failed' : task.status === 'pending' ? 'waiting' : 'running',
            startedAt: now,
          })
        }
        return {
          ...st,
          tasks,
          agents: st.agents.map(a => (a.background && !a.endedAt && !ids.has(a.id) ? { ...a, endedAt: now } : a)),
        }
      })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e)
    const usage = r.usage
    const phase = !e.agentId && r.answer ? parsePhase(r.answer) : null
    if (usage || phase) {
      await upd($, st => {
        const nextPhase = phase ?? st.phase
        let { main, mainModel, agents, perPhase } = st
        if (usage) {
          if (e.agentId) {
            agents = agents.map(a => (a.id === e.agentId ? { ...a, tokens: add(a.tokens, usage), model: usage.model || a.model } : a))
          } else {
            main = add(main, usage)
            mainModel = usage.model || mainModel
          }
          const key = phaseKey(nextPhase)
          const hit = perPhase.find(p => p.key === key)
          perPhase = hit
            ? perPhase.map(p => (p.key === key ? { ...p, out: p.out + usage.output_tokens } : p))
            : [...perPhase, { key, out: usage.output_tokens }].slice(-12)
        }
        return { ...st, phase: nextPhase, main, mainModel, agents, perPhase }
      })
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const now = await $.clock.now()
      await upd($, st => ({ ...st, agents: st.agents.map(a => (a.id === e.agentId ? { ...a, endedAt: now } : a)) }))
    }
    return next(e)
  })

  // ---------- Band above the prompt (option A) ----------
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    await read($, tick)
    const st = withLive(fill(await read($, hud)), await $.session.usage())
    const folded = await read($, isFolded)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)

    const running = st.workflows
      .map(w => ({ w, agents: st.agents.filter(a => a.workflowId === w.id) }))
      .filter(x => x.agents.length === 0 || x.agents.some(a => !a.endedAt))
    const loose = st.agents.filter(a => !a.workflowId && !a.endedAt && !a.background)
    const tasks = settle(st.tasks, now)
    const bgAgents = st.agents.filter(a => a.background && !a.endedAt)

    const fold = <Button key="fold" label={folded ? '▾' : '▴'} plain onPress={() => update($, isFolded, f => !f)} />

    // ----- Line 1: the headline — the phase, else the running work, else the current task
    const active = tasks.filter(isActive)
    const real = active.filter(t => t.kind !== 'wake')
    const shown = (real.length ? real : active).sort((a, b) => a.startedAt - b.startedAt)
    const currentTask = bgAgents.length
      ? { glyph: '●', color: 'green' as const, kind: 'agent', label: bgAgents[0]!.label, since: bgAgents[0]!.startedAt }
      : shown[0]
        ? { glyph: glyph(shown[0]), color: glyphColor(shown[0]), kind: shown[0].kind, label: shown[0].label, since: shown[0].startedAt }
        : null
    const firstRun = running[0]
    const headline = st.phase ? (
      <Text wrap="truncate-end">
        <Text color="claude">◔</Text> <Text bold>
          {st.phase.n}/{st.phase.total}
        </Text>{' '}
        <Text color="claude">{split(st.phase.pct)[0]}</Text>
        <Text dimColor>{split(st.phase.pct)[1]}</Text> <Text bold>{st.phase.pct}%</Text> {st.phase.title}
      </Text>
    ) : firstRun ? (
      <Text wrap="truncate-end">
        <Text color="success">●</Text> <Text bold>{firstRun.w.name}</Text>
        <Text dimColor>
          {' '}· {firstRun.agents.length} agents{firstRun.agents.filter(a => a.endedAt).length ? ` · ${firstRun.agents.filter(a => a.endedAt).length} done` : ''} ·{' '}
          {fmtDuration(now - firstRun.w.startedAt)}
        </Text>
      </Text>
    ) : loose.length ? (
      <Text wrap="truncate-end">
        <Text color="success">●</Text> <Text bold>{loose.map(a => a.label).join(', ')}</Text>
        <Text dimColor> · {fmtDuration(now - Math.min(...loose.map(a => a.startedAt)))}</Text>
      </Text>
    ) : currentTask ? (
      <Text wrap="truncate-end">
        <Text color={currentTask.color}>{currentTask.glyph}</Text> <Text dimColor>{kindIcon(currentTask.kind)}</Text> <Text bold>{currentTask.label}</Text>
        <Text dimColor> · {fmtDuration(now - currentTask.since)}</Text>
      </Text>
    ) : (
      <Text dimColor>idle</Text>
    )

    const line1 = (
      <Box key="headline" flexDirection="row" flexWrap="nowrap" gap={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          {headline}
        </Box>
        <Box flexShrink={0}>{fold}</Box>
      </Box>
    )
    if (folded) return <Box flexDirection="column">{line1}</Box>

    // ----- Line 2: one flat row of stats, each pressable, separated by a thin rule.
    // No boxes: a desktop draws a bordered Box as a large rounded rect, which
    // swamped the band (0.6.0). Each stat is measured so none is ever half-cut.
    const count = (icon: string, n: number, color: 'green' | 'red') => (
      <Text>
        <Text color={n ? color : undefined} dimColor={!n}>
          {icon}
        </Text>
        <Text dimColor={!n} bold={!!n}>
          {n}
        </Text>
      </Text>
    )
    const agentsRunning = st.agents.filter(a => !a.endedAt && !a.background).length
    const agentsDone = st.agents.filter(a => a.endedAt && !a.background).length
    const nActive = active.length + bgAgents.length
    const nDone = tasks.filter(t => t.status === 'done' || t.status === 'killed').length + st.agents.filter(a => a.background && a.endedAt).length
    const nFailed = tasks.filter(t => t.status === 'failed').length

    type Chip = { section: Section; width: number; body: JSX.Element }
    const agentsText = agentsRunning + agentsDone === 0 ? '⚙ idle' : `⚙ ●${agentsRunning} ✓${agentsDone}`
    const tasksText = `●${nActive} ✓${nDone} ✗${nFailed}`
    const allChips: Chip[] = [
      {
        section: 'agents',
        width: agentsText.length,
        body:
          agentsRunning + agentsDone === 0 ? (
            <Text dimColor>⚙ idle</Text>
          ) : (
            <Text>
              <Text dimColor>⚙</Text> {count('●', agentsRunning, 'green')} {count('✓', agentsDone, 'green')}
            </Text>
          ),
      },
      {
        section: 'background',
        width: tasksText.length,
        body: (
          <Text>
            {count('●', nActive, 'green')} {count('✓', nDone, 'green')} {count('✗', nFailed, 'red')}
          </Text>
        ),
      },
      ...st.limits.map(l => ({
        section: 'limits' as Section,
        width: 4 + `${l.percentUsed}% ${limitName(l.kind)}`.length + 1,
        body: (
          <Text>
            <Text color={limitColor(l.percentUsed)}>{split(l.percentUsed, 4)[0]}</Text>
            <Text dimColor>{split(l.percentUsed, 4)[1]}</Text> <Text bold>{l.percentUsed}%</Text> <Text dimColor>{limitName(l.kind)}</Text>
          </Text>
        ),
      })),
      {
        section: 'session',
        width: 2 + fmtTokens(st.main.out).length,
        body: (
          <Text>
            <Text dimColor>↑</Text> <Text bold>{fmtTokens(st.main.out)}</Text>
          </Text>
        ),
      },
    ]

    // Keep only what fits: the band's width less the › button, 3 columns per rule.
    let left = (e.props.bodyColumns ?? 80) - 3
    const fitted: Chip[] = []
    for (const c of allChips) {
      const needs = c.width + (fitted.length ? 3 : 0)
      if (needs > left) break
      left -= needs
      fitted.push(c)
    }

    return (
      <Box flexDirection="column">
        {line1}
        <Box key="chips" flexDirection="row" flexWrap="nowrap" gap={1}>
          <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" flexDirection="row" flexWrap="nowrap" gap={1}>
            {fitted.map((c, i) => (
              <Box key={`cell-${c.section}-${i}`} flexDirection="row" flexShrink={0} gap={1}>
                {i > 0 ? <Text dimColor>│</Text> : null}
                {c.body}
              </Box>
            ))}
          </Box>
          <Box flexShrink={0}>
            <Button key="open" label="›" plain onPress={() => openAt($, st.phase ? 'phase' : currentTask ? 'background' : 'agents')} />
          </Box>
        </Box>
      </Box>
    )
  })

  // ---------- Side pane (option B) ----------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const live = await $.session.usage()
    const st = withLive(fill(await read($, hud)), live)
    const sessionStart = live.startedAt
    const at = await read($, focus)
    const tab = await read($, bgTab)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const tasks = settle(st.tasks, now)

    const head2 = (s: Section, title: string) => (
      <Text key={`st-${s}`} bold color={s === at ? 'cyan' : undefined}>
        {s === at ? '▶ ' : ''}
        {title}
      </Text>
    )
    const kv = (k: string, v: string) => (
      <Box key={k} flexDirection="row">
        <Text dimColor>{k}</Text>
        <Box flexGrow={1} />
        <Text mono>{v}</Text>
      </Box>
    )

    const sections: Record<Section, JSX.Element> = {
      phase: (
        <Box key="phase" flexDirection="column">
          {head2('phase', 'Phase')}
          {st.phase ? (
            <>
              <Text mono>
                {st.phase.n}/{st.phase.total} <Text color="claude">{split(st.phase.pct)[0]}</Text>
                <Text dimColor>{split(st.phase.pct)[1]}</Text> {st.phase.pct}%
              </Text>
              <Text dimColor>{st.phase.title}</Text>
            </>
          ) : (
            <Text dimColor>No phase bar in this chat yet.</Text>
          )}
        </Box>
      ),
      limits: (
        <Box key="limits" flexDirection="column">
          {head2('limits', 'Plan limits')}
          {st.limits.length === 0 && <Text dimColor>No reading yet (shows after the first reply on a subscription).</Text>}
          {st.limits.map(l => (
            <Box key={l.kind} flexDirection="row">
              <Text>{limitName(l.kind)} </Text>
              <Text color={limitColor(l.percentUsed)}>{split(l.percentUsed)[0]}</Text><Text dimColor>{split(l.percentUsed)[1]}</Text>
              <Box flexGrow={1} />
              <Text mono>
                {l.percentUsed}% {resetLabel(l.resetsAt) && `· resets ${resetLabel(l.resetsAt)}`}
              </Text>
            </Box>
          ))}
        </Box>
      ),
      session: (
        <Box key="session" flexDirection="column">
          {head2('session', 'This session')}
          {kv('Model', st.mainModel ? shortModel(st.mainModel) : '—')}
          {kv('Output', fmtTokens(st.main.out))}
          {kv('Input (fresh)', fmtTokens(st.main.fresh))}
          {kv('Cache read · written', `${fmtTokens(st.main.cacheRead)} · ${fmtTokens(st.main.cacheWrite)}`)}
          {kv('Time', sessionStart ? fmtDuration(now - sessionStart) : '—')}
          {kv('Incl. agents · output', fmtTokens(st.main.out + st.agents.reduce((s, a) => s + a.tokens.out, 0)))}
        </Box>
      ),
      agents: (
        <Box key="agents" flexDirection="column">
          {head2('agents', 'Workflows & agents')}
          {st.agents.length === 0 && <Text dimColor>No agents yet.</Text>}
          {[...st.workflows.map(w => ({ id: w.id, name: w.name })), { id: '', name: 'Agents' }].map(group => {
            const rows = st.agents.filter(a => (group.id ? a.workflowId === group.id : !a.workflowId && !a.background))
            if (rows.length === 0) return null
            const total = rows.reduce((s, a) => s + a.tokens.out, 0)
            return (
              <Box key={`g-${group.id || 'loose'}`} flexDirection="column" marginTop={1}>
                <Text>{group.name}</Text>
                {[...rows]
                  .sort((a, b) => b.tokens.out - a.tokens.out)
                  .map(a => (
                    <Box key={a.id} flexDirection="row">
                      <Text dimColor={!!a.endedAt} wrap="truncate-end">
                        {a.endedAt ? '✓' : '●'} {a.label}{' '}
                        <Text dimColor>
                          {shortModel(a.model)} · {fmtDuration((a.endedAt ?? now) - a.startedAt)}
                        </Text>
                      </Text>
                      <Box flexGrow={1} />
                      <Text mono>{fmtTokens(a.tokens.out)}</Text>
                    </Box>
                  ))}
                {kv(`Total · ${rows.length} agents · ${fmtTokens(rows.reduce((s, a) => s + a.tokens.cacheRead, 0))} cache`, fmtTokens(total))}
              </Box>
            )
          })}
        </Box>
      ),
      background: (() => {
        const bgAgentsAll = st.agents.filter(a => a.background)
        type Row = { key: string; glyph: string; color?: 'green' | 'yellow' | 'red'; kind: string; label: string; detail?: string; since: number; until?: number; tab: BgTab }
        const rows: Row[] = [
          ...bgAgentsAll.map((a): Row => ({ key: a.id, glyph: a.endedAt ? '✓' : '●', color: a.endedAt ? undefined : ('green' as const), kind: 'agent', label: a.label, detail: `${shortModel(a.model)} · ${fmtTokens(a.tokens.out)} out`, since: a.startedAt, until: a.endedAt, tab: (a.endedAt ? 'done' : 'active') as BgTab })),
          ...tasks.filter(t => t.kind !== 'wake').map((t): Row => ({ key: t.id, glyph: glyph(t), color: glyphColor(t), kind: t.kind, label: t.label, detail: t.status === 'failed' ? `exit ${t.exitCode ?? '?'}${t.detail ? ` · ${t.detail}` : ''}` : t.status === 'killed' ? `stopped${t.detail ? ` · ${t.detail}` : ''}` : t.detail, since: t.startedAt, until: t.endedAt, tab: (isActive(t) ? 'active' : t.status === 'failed' ? 'failed' : 'done') as BgTab })),
        ]
        const wakes = tasks.filter(t => t.kind === 'wake' && isActive(t))
        const count = (k: BgTab) => rows.filter(r => r.tab === k).length
        const list = rows.filter(r => r.tab === tab).sort((a, b) => (b.until ?? b.since) - (a.until ?? a.since))
        const tabBtn = (k: BgTab, title: string) => (
          <Button key={`bg-${k}`} plain onPress={() => update($, bgTab, () => k)}>
            <Text bold={k === tab} color={k === tab ? 'cyan' : undefined} dimColor={k !== tab}>
              {k === 'active' ? '●' : k === 'done' ? '✓' : '✗'} {title} {count(k)}
            </Text>
          </Button>
        )
        return (
          <Box key="background" flexDirection="column">
            {head2('background', 'Background tasks')}
            <Box flexDirection="row" gap={2}>
              {tabBtn('active', 'Active')}
              {tabBtn('done', 'Finished')}
              {tabBtn('failed', 'Failed')}
            </Box>
            {list.length === 0 && <Text dimColor>{tab === 'active' ? 'Nothing running in the background.' : 'None yet.'}</Text>}
            {list.map(r => (
              <Box key={r.key} flexDirection="column">
                <Box flexDirection="row">
                  <Text wrap="truncate-end" dimColor={r.tab !== 'active'}>
                    <Text color={r.color}>{r.glyph}</Text> <Text dimColor>{kindIcon(r.kind)}</Text> {r.label}
                  </Text>
                  <Box flexGrow={1} />
                  <Text mono>{fmtDuration((r.until ?? now) - r.since)}{r.until ? ` · ${clock(r.until)}` : ''}</Text>
                </Box>
                {r.detail && <Text dimColor wrap="truncate-end">{'    '}{r.detail}</Text>}
              </Box>
            ))}
            {tab !== 'active' && rows.some(r => r.tab !== 'active') && <Text dimColor>Finished and Failed keep the last 40 of this session.</Text>}
            {wakes.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text>Scheduled wakeups</Text>
                {wakes.map(w => kv(`⏰ ${w.label}`, w.recurring ? (w.detail ?? 'recurring') : w.dueAt ? `in ${fmtDuration(Math.max(0, w.dueAt - now))} · once` : 'once'))}
              </Box>
            )}
          </Box>
        )
      })(),
      phases: (
        <Box key="phases" flexDirection="column">
          {head2('phases', 'Per phase (output tokens)')}
          {st.perPhase.length === 0 && <Text dimColor>Nothing counted yet.</Text>}
          {st.perPhase.map(p => kv(p.key, fmtTokens(p.out)))}
        </Box>
      ),
    }

    const order: Section[] = ['phase', 'limits', 'session', 'agents', 'background', 'phases']
    const sorted = [at, ...order.filter(s => s !== at)]
    return (
      <Box flexDirection="column" gap={1}>
        {sorted.map(s => sections[s])}
      </Box>
    )
  })
}
