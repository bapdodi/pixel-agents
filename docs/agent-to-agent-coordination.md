# Agent-to-Agent Coordination

This document describes how Pixel Agents currently creates agents, routes inter-agent messages, and visualizes coordination in the UI.

It is based on the current implementation in:

- `src/agentManager.ts`
- `src/coordinationManager.ts`
- `src/coordinationPersistence.ts`
- `src/coordinationWatcher.ts`
- `src/mcp-server.ts`
- `webview-ui/src/hooks/useExtensionMessages.ts`
- `webview-ui/src/office/engine/officeState.ts`
- `webview-ui/src/office/engine/coordinationRenderer.ts`

## Overview

Pixel Agents uses a file-backed coordination layer under `~/.pixel-agents/coordination/`.

There are three main parts:

1. Agent creation and registration
2. File-based coordination between agents
3. Webview-side visualization of that coordination

The important design choice is that the VS Code extension is the coordinator. Agents do not talk directly to each other in memory. Instead, they write coordination messages into inbox files, and the extension routes and visualizes those messages.

## 1. How an Agent Is Created

The spawn path starts in [`src/PixelAgentsViewProvider.ts`](../src/PixelAgentsViewProvider.ts) when the webview sends `openClaude`.

From there:

1. [`launchNewTerminal`](../src/agentManager.ts) creates a new logical agent ID.
2. The webview is notified immediately with `agentCreated` so the character appears without waiting for transcript discovery.
3. A real terminal/PTY is launched for the selected provider (`claude`, `gemini`, or `openai`).
4. A per-agent session ID is generated with `crypto.randomUUID()`.
5. Provider-specific command building happens in [`src/providers`](../src/providers).
6. Coordination environment variables are injected into the process via `buildCoordEnv()`.
7. The agent is registered into the coordination registry with `registerAgent()`.
8. A coordination instruction string is injected into the PTY with `buildCoordContextMessage()`.
9. Transcript watching starts once the provider JSONL file is found.

### Coordination env injected into each agent

These variables are the contract between the extension and the running CLI:

```text
PIXEL_AGENTS_SESSION_ID
PIXEL_AGENTS_REGISTRY
PIXEL_AGENTS_INBOX
PIXEL_AGENTS_COORD_DIR
```

The extension also prepends `dist/agent-tools` to `PATH` or `Path`, so helper CLIs like `pa_spawn_agent` are callable from the agent terminal.

## 2. Coordination Storage Layout

The runtime coordination state lives here:

```text
~/.pixel-agents/coordination/
  agents/
    <session-id>.json
  inbox/
    <session-id>.jsonl
  inbox-claims/
    <session-id>/
      <message-claim>.json
  tasks/
    pending/
    claimed/
    done/
    failed/
  mcp-configs/
    <session-id>.json
  registry.json
  history.jsonl
```

### What each file is for

- `agents/<session-id>.json`: authoritative per-agent metadata written by the extension
- `registry.json`: rebuilt summary of live agents, used for discovery
- `inbox/<session-id>.jsonl`: append-only mailbox for that agent
- `inbox-claims/...`: idempotency guard so the same inbox line is not processed twice
- `tasks/...`: file-based shared task queue
- `history.jsonl`: recent routed-message history for UI diagnostics
- `mcp-configs/<session-id>.json`: per-session MCP configuration for providers that need it

## 3. How Agents Discover Each Other

Discovery is registry-based.

When an agent is registered, [`registerAgent`](../src/coordinationManager.ts) writes an [`AgentRegistryEntry`](../src/types.ts) containing:

- `sessionId`
- `agentId`
- `providerId`
- `providerName`
- `role`
- `roleDescription`
- `capabilities`
- `status`
- `currentTask`
- `inboxFile`
- timestamps

The registry is not updated by agents directly. The extension rebuilds it from `agents/*.json`, filters out stale entries, and writes `registry.json`.

This avoids multi-writer corruption on a single shared registry file.

## 4. How Agents Communicate

### Routing model

Agents do not write to another agent's inbox directly in the application model. Instead, they append a coordination message to their own inbox, and the extension later routes it.

The flow is:

```text
Agent A
  -> append send_to / spawn_agent / set_role message to its own inbox
  -> extension watcher/poller detects new inbox lines
  -> coordinationManager processes those control messages
  -> extension writes routed message into Agent B inbox
  -> webview receives an arc event for visualization
```

### Inbox processing

[`initCoordination`](../src/coordinationManager.ts) starts two mechanisms:

- polling every `COORDINATION_AGENT_POLL_MS`
- a single directory watcher on `coordination/inbox/`

The watcher is intentionally O(1) with respect to agent count because it watches the inbox directory once, not one watcher per agent.

### Message types

[`CoordinationMessage`](../src/types.ts) currently supports:

- `message`
- `delegate`
- `result`
- `broadcast`
- `send_to`
- `set_role`
- `spawn_agent`
- `decline`
- `ack`

In practice, the currently wired control flow is:

- `send_to`: route a message to another session
- `set_role`: update role metadata
- `spawn_agent`: request a new agent spawn

### Message routing internals

[`processSendToMessages`](../src/coordinationManager.ts) reads unread inbox lines, claims them via `claimInboxMessage()`, and then:

- routes `send_to` through `_routeSendTo()`
- handles `set_role`
- handles `spawn_agent`

`_routeSendTo()`:

- enriches the message with sender metadata via `buildRoutedMessage()`
- increments `chainDepth`
- drops messages deeper than 5 hops
- appends the routed message to the target inbox
- writes a history entry to `history.jsonl`
- notifies the webview to draw an arc

## 5. How Sub-Agent Spawning Works

There are two different "spawn" concepts in the codebase:

### Provider-native sub-agents

Claude tool calls like `Task` or `Agent` are detected from transcript parsing and visualized as temporary sub-agent characters in the webview. These are not independently registered team agents.

The UI path is:

1. transcript parser emits `agentToolStart` with a `Subtask:` label
2. [`useExtensionMessages`](../webview-ui/src/hooks/useExtensionMessages.ts) creates a sub-agent character
3. [`OfficeState.addSubagent`](../webview-ui/src/office/engine/officeState.ts) spawns it near the parent

### Pixel Agents team-agent spawn

This is the coordination-layer spawn:

1. an agent calls `pa_spawn_agent` or MCP `pa_spawn_agent`
2. a `spawn_agent` message is appended to the current agent inbox
3. `coordinationManager` handles it with `_handleSpawnAgent()`
4. the registered `onSpawnAgent` callback calls `launchNewTerminal()`
5. the new agent is created, registered, and shown in the office

This is the real "create another managed teammate" path.

## 6. MCP and Helper Tools

There are two ways the current implementation exposes coordination features to agents.

### Shell helper tools

The extension places these into the agent PATH:

- `pa_spawn_agent`
- `pa_list_agents`
- `pa_send_message`
- `pa_task_create`
- `pa_task_claim`
- `pa_task_done`
- `pa_task_list`

There are also older `pixel-*` variants still present in the repo.

### MCP server

[`src/mcp-server.ts`](../src/mcp-server.ts) currently exposes these MCP tools:

- `pa_list_agents`
- `pa_spawn_agent`
- `pa_send_message`
- `pa_set_role`

Current limitation: task MCP tools are not implemented yet in `mcp-server.ts`, even though file-based task storage already exists.

## 7. Shared Task Architecture

Shared tasks are file-backed and grouped by status directory:

```text
tasks/pending
tasks/claimed
tasks/done
tasks/failed
```

### Why this is safe enough

Claiming uses atomic rename in [`claimTaskSync`](../src/coordinationPersistence.ts):

```text
pending/<task>.json -> claimed/<task>.<sessionId>
```

That means only one claimer wins without needing a separate lock service.

### Lifecycle currently implemented in backend

- create: `createSharedTask()`
- claim: `claimSharedTask()`
- complete: `completeSharedTask()`
- fail: `failSharedTask()`
- timeout recovery: `recoverTimedOutTasks()`
- rollback on agent disappearance: `rollbackTasksForSession()`

### Current UI gap

The webview sends `coordination: claimTask` from [`TaskPanel.tsx`](../webview-ui/src/components/TaskPanel.tsx), but [`PixelAgentsViewProvider.ts`](../src/PixelAgentsViewProvider.ts) does not currently handle `claimTask`.

So:

- task creation is wired
- task listing is wired
- backend task claiming exists
- UI claim action is not fully connected yet

This is important if you are documenting "current behavior" vs "intended architecture."

## 8. How the UI Visualizes Coordination

The extension talks to the React webview through `postMessage`.

Implemented coordination messages include:

- `coordination / registry`
- `coordination / roleUpdated`
- `coordination / arc`
- `coordination / taskList`
- `coordination / log`
- `coordination / notification`

### Registry and roles

[`useExtensionMessages`](../webview-ui/src/hooks/useExtensionMessages.ts) stores registry entries and mirrors them into `agentRoles`.

### Message arcs

When routing happens, the extension emits:

```text
{ type: 'coordination', subtype: 'arc', fromId, toId, arcType }
```

The webview passes that to [`OfficeState.addCoordinationArc`](../webview-ui/src/office/engine/officeState.ts), and [`coordinationRenderer.ts`](../webview-ui/src/office/engine/coordinationRenderer.ts) renders animated bezier arcs.

Arc colors:

- `message`: blue
- `delegate`: amber
- `result`: green
- `broadcast`: purple

### Notifications

`spawn_agent` currently emits a short system notification so the user sees that an agent is being summoned.

## 9. Current Implementation Boundaries

The codebase already has a solid coordination backbone, but not every planned feature is fully connected yet.

### Working now

- per-agent registration and discovery
- file-backed inboxes
- routed direct messages through `send_to`
- team-agent spawning through coordination
- role updates
- shared task persistence and recovery logic
- coordination arcs in the office UI
- MCP server registration for Claude, Gemini, and OpenAI/Codex

### Partially wired or incomplete

- task claim from UI is not handled by the extension message layer yet
- task completion/failure is implemented in backend helpers but not exposed in the current webview flow
- a `coordination/message` UI path exists in the webview, but the extension currently emits arcs and logs, not a dedicated delivered-message event
- MCP task tools are not implemented yet

## 10. Design Summary

The current architecture is best understood as:

- terminal/PTY lifecycle in `agentManager`
- durable coordination state in filesystem-backed persistence
- routing/orchestration in `coordinationManager`
- provider-specific launch and transcript parsing in `src/providers`
- purely visual office-state rendering in the webview

That separation is what makes the system extensible:

- new providers can be added without rewriting the office UI
- the UI can visualize coordination without owning routing logic
- crash recovery is possible because the source of truth is file-based, not only in memory

## 11. Suggested Next Documentation Targets

If you want to extend this further, the next useful docs would be:

1. a provider adapter guide covering transcript formats and launch semantics
2. a task lifecycle doc after the UI claim/complete path is fully wired
3. a message schema reference for extension `<->` webview events
