# usage-hud

An always-on status band above the Claude Code prompt, with a matching side pane.

The band keeps two lines in view at every scroll position:

- **Headline** — the phase bar of a multi-phase plan when there is one, otherwise the workflow or agent that is running, otherwise the current background task, with its elapsed time.
- **Stats** — `⚙` agents, `●✓✗` background tasks (active, finished, failed), the 5-hour and weekly plan-limit meters, and output tokens. Stats that do not fit the pane are dropped whole, never cut in half.

`▾` folds the band to its headline. `›` opens the **Usage** pane, which adds plan limits with reset times, this session's tokens and cache, every workflow agent with its model and cost, background tasks under Active / Finished / Failed tabs, scheduled wakeups, and a per-phase token split. `/usage-hud` opens the same pane.

Background work is tracked from the engine's own events, so a shell command run in the background, an MCP monitor, a scheduled wakeup and a background subagent all appear. The mod adopts work that is already under way when it loads, which matters when it is reloaded into a busy session.

It costs no tokens: it never calls a model, and nothing it draws enters the conversation. It only reads figures Claude Code already has.

## Install

At the prompt of a terminal session:

```
/plugin install usage-hud --marketplace Robotukas/usage-hud
```

Answer `y` to add the marketplace, then choose a scope (the user scope loads it in every session).

## Develop

```bash
claude plugin validate .
claude plugin test .
```

Edit `hooks/register.tsx`, then `/reload-plugins` in any open session to pick up the change.
