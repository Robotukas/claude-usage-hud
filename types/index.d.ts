export type Tokens = { out: number; fresh: number; cacheRead: number; cacheWrite: number }

export type Phase = { n: number; total: number; pct: number; title: string }

export type AgentRow = {
  id: string
  label: string
  model: string
  workflowId?: string
  background?: boolean
  startedAt: number
  endedAt?: number
  tokens: Tokens
}

export type WorkflowRow = { id: string; name: string; startedAt: number }

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type TaskKind = 'shell' | 'monitor' | 'wake' | 'agent' | 'workflow'
export type TaskStatus = 'running' | 'waiting' | 'done' | 'failed' | 'killed'

// A background task: a Bash command run in the background, an MCP monitor,
// or a scheduled wakeup (ScheduleWakeup / CronCreate). Background agents
// stay in `agents` with `background: true`.
export type TaskRow = {
  id: string // the tool_use_id of the call that started it
  taskId?: string // the engine's task id, as a task-notification names it
  kind: TaskKind
  label: string
  detail?: string
  status: TaskStatus
  startedAt: number
  endedAt?: number
  dueAt?: number // wake: when it fires
  recurring?: boolean
  exitCode?: number
}

export type Section = 'phase' | 'limits' | 'session' | 'agents' | 'background' | 'phases'
export type BgTab = 'active' | 'done' | 'failed'

export type Hud = {
  phase: Phase | null
  main: Tokens
  mainModel: string
  agents: AgentRow[]
  workflows: WorkflowRow[]
  tasks: TaskRow[]
  limits: Limit[]
  perPhase: { key: string; out: number }[]
}

declare module 'claude-code' {
  interface PluginState {
    'usage-hud': { hud: Hud; isFolded: boolean; focus: Section; bgTab: BgTab; tick: number }
  }
}
