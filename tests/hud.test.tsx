import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'usage-hud',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 12, bodyColumns: 120, scroll: { offset: 0, bodyRows: 12 }, view: {} },
} as const

const PANE = {
  plugin: 'usage-hud',
  component: 'Pane',
  requestId: 'usage-hud',
  props: { title: 'Usage', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const usage = (out: number) => ({
  model: 'claude-opus-5-5',
  input_tokens: 10,
  output_tokens: out,
  cache_read_input_tokens: 5000,
  cache_creation_input_tokens: 100,
})

test('the band shows the phase bar, a running workflow and the limits; › opens the pane at that section', async ($, on) => {
  const opened: unknown[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({ value: { startedAt: 1_000_000, context: {} as never, rateLimits: [] } }))
  on('command.register', () => ({ value: { command: 'usage-hud' } }))
  on('ui.open', (_, e) => (opened.push(e), { value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'ag-1' }))
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: e.agentId ? '' : 'Phase 2/5 ▰▰▰▰▱▱▱▱▱▱ 40% · Build UI — checkpoint\n\nRest of the message.',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: usage(e.agentId ? 3000 : 1200),
    }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Workflow', tool_use_id: 'wf-call-1', script: "export const meta = { name: 'explore-plan-upload-folders' }" })
  await $.agent.spawn({
    tool_use_id: 'wf-call-1',
    prompt: 'map the upload dialog',
    description: 'explore:upload-dialog',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' } as never,
    parentModel: 'claude-fable-5-1',
    background: true,
    fork: false,
    workflow: { runId: 'wf_test', agentIndex: 1 },
  })
  await clock.advance(95_000)
  // The ticker redraws while the agent runs: elapsed time reads 1m 35s.
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-fable-5-1', messageCount: 1 })) void _
  for await (const _ of $.turn.step({ turnId: 't2', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'ag-1' })) void _
  await $.session.measure({
    context: { window: 200000 } as never,
    rateLimits: [{ kind: 'five_hour', percentUsed: 62, resetsAt: '2026-10-25T12:00:00Z' }, { kind: 'seven_day', percentUsed: 78 }],
    changed: ['rateLimits'],
  })

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await band.find({ type: 'Text', text: /2\/5/ }))?.text).toContain('40% Build UI — checkpoint')
  expect((await band.find({ type: 'Text', text: /62%/ }))?.text).toContain('5h')
  expect((await band.find({ type: 'Text', text: /↑/ }))?.text).toContain('1.2k')
  expect((await band.find({ type: 'Text', text: /⚙/ }))?.text).toContain('⚙')

  await band.press({ key: 'open' })
  expect(opened.length).toBe(1)
  await band.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // › opens the pane at the headline's own subject, here the phase, marked ▶.
  expect((await pane.find({ type: 'Text', text: /▶/ }))?.text).toContain('Phase')
  expect((await pane.find({ type: 'Text', text: /explore:upload-dialog/ }))?.text).toContain('explore:upload-dialog')
  await pane.unmount()
})

test('folding the band leaves one row', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({ value: { startedAt: 1_000_000, context: {} as never, rateLimits: [{ kind: 'five_hour', percentUsed: 91 }] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'usage-hud' } }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band.find({ type: 'Text', text: /idle/ })).toBeTruthy()
  // Live readings show straight away, before any session.measure.
  expect((await band.find({ type: 'Text', text: /91%/ }))?.text).toContain('5h')
  await band.press({ key: 'fold' })
  expect(await band.find({ type: 'Text', text: /91%/ })).toBeFalsy()
  await band.unmount()
})

test('a background command shows in the band, then moves to the Failed tab on its notification', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({ value: { startedAt: 1_000_000, context: {} as never, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'usage-hud' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b0rl6bk24' } }))
  on('session.receive', () => ({ consumed: 'no' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('classic.Stop', () => ({}))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'toolu_bash1', command: 'npm run dev > dev.log', description: 'Start the worktree dev server on port 8080', run_in_background: true })
  await clock.advance(134_000)

  const band = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const chip = await band.find({ type: 'Text', text: /dev server on port 8080/ })
  expect(chip?.text).toContain('$')
  expect(chip?.text).toContain('2m 14s')
  expect((await band.find({ type: 'Text', text: /✗0/ }))?.text).toContain('●1')
  await band.unmount()

  await $.prompt.submit({
    origin: { kind: 'task-notification' },
    wait: false,
    text: '<task-notification>\n<task-id>b0rl6bk24</task-id>\n<tool-use-id>toolu_bash1</tool-use-id>\n<status>failed</status>\n<summary>Background command "Start the worktree dev server on port 8080" failed (exit code 1)</summary>\n</task-notification>',
  } as never)

  const band2 = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await band2.find({ type: 'Text', text: /idle/ })).toBeTruthy()
  expect((await band2.find({ type: 'Text', text: /✗1/ }))?.text).toContain('●0')
  await band2.unmount()

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /Failed/ }))?.text).toContain('✗ Failed 1')
  await pane.press({ key: 'bg-failed' })
  const row = await pane.find({ type: 'Text', text: /dev server on port 8080/ })
  expect(row?.text).toContain('✗')
  expect((await pane.find({ type: 'Text', text: /exit 1/ }))?.text).toContain('exit 1')
  await pane.unmount()
})

test('stats are coloured Text, not Buttons, and a narrow band keeps whole stats only', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({ value: { startedAt: 1_000_000, context: {} as never, rateLimits: [{ kind: 'five_hour', percentUsed: 42 }, { kind: 'seven_day', percentUsed: 75 }] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'usage-hud' } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // Wide: every stat is drawn. Stats are plain Text, never Buttons: a Button
  // draws its children in its own style and flattens the colours they carry.
  const wide = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await wide.find({ type: 'Text', text: /42%/ })).toBeTruthy()
  expect(await wide.find({ type: 'Text', text: /75%/ })).toBeTruthy()
  expect(await wide.find({ key: 'chip-limits' })).toBeFalsy()
  await wide.unmount()

  // Narrow: the stats that do not fit are dropped whole, never clipped.
  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 20 }, surface: 'desktop' })
  expect(await narrow.find({ type: 'Text', text: /idle/ })).toBeTruthy()
  expect(await narrow.find({ type: 'Text', text: /75%/ })).toBeFalsy()
  await narrow.unmount()
})

test('a mod loading into a busy session adopts the work already under way', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('session.usage', () => ({ value: { startedAt: 1_000_000, context: {} as never, rateLimits: [] } }))
  on('command.register', () => ({ value: { command: 'usage-hud' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.Stop', () => ({}))
  // The engine already has an agent running when the mod loads.
  on('agent.list', () => ({
    value: [{ id: 'ag-live', description: 'Implement Task 1: pure layer', type: 'general-purpose', status: 'running' }],
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /⚙/ }))?.text).toContain('●1')
  await band.unmount()

  // A Stop names background work this mod never saw start; it is adopted.
  await $.classic.Stop({
    background_tasks: [
      { id: 'bg-1', type: 'subagent', status: 'running', description: 'Implement Task 1: pure layer', agent_type: 'general-purpose' },
      { id: 'bg-2', type: 'shell', status: 'running', description: 'dev server', command: 'npm run dev' },
    ],
  } as never)

  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await after.find({ type: 'Text', text: /✗0/ }))?.text).toContain('●2')
  await after.unmount()
})
