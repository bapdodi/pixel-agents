import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

import { COORDINATION_AGENT_POLL_MS, LAYOUT_FILE_DIR, TASK_HEARTBEAT_MS } from './constants.js';
import {
  appendHistory,
  appendToInbox,
  buildRoutedMessage,
  claimTaskSync,
  completeTask,
  createTask,
  deleteAgentEntry,
  deleteInboxFile,
  ensureCoordDirs,
  ensureTaskDirs,
  failTask,
  getCoordDir,
  listAllTasks,
  pruneStaleAgentFiles,
  readAgentEntry,
  readNewInboxMessages,
  recoverTimedOutTasks,
  refreshRegistry,
  rollbackTasksForSession,
  writeAgentEntry,
} from './coordinationPersistence.js';
import { startInboxWatcher, stopInboxWatcher } from './coordinationWatcher.js';
import type {
  AgentRegistryEntry,
  AgentState,
  CoordinationMessage,
  CoordLogEntry,
  SharedTask,
} from './types.js';

// ── Module state ──────────────────────────────────────────────

let _agents: Map<number, AgentState> | null = null;
let _getWebview: (() => vscode.Webview | undefined) | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _heartbeatTimer: ReturnType<typeof setInterval> | null = null;

// ── Init / Teardown ───────────────────────────────────────────

export async function initCoordination(
  agents: Map<number, AgentState>,
  getWebview: () => vscode.Webview | undefined,
): Promise<void> {
  _agents = agents;
  _getWebview = getWebview;
  await ensureCoordDirs();
  await ensureTaskDirs();

  if (_pollTimer) clearInterval(_pollTimer);
  _pollTimer = setInterval(() => void _poll(), COORDINATION_AGENT_POLL_MS);

  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = setInterval(() => void _heartbeat(), TASK_HEARTBEAT_MS);

  startInboxWatcher(() => void _poll());
}

export function disposeCoordination(): void {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  if (_heartbeatTimer) {
    clearInterval(_heartbeatTimer);
    _heartbeatTimer = null;
  }
  stopInboxWatcher();
}

// ── Agent registration ────────────────────────────────────────

export async function registerAgent(agent: AgentState): Promise<void> {
  if (!agent.sessionId) return;

  const coordDir = getCoordDir();
  const inboxFile = path.join(coordDir, 'inbox', `${agent.sessionId}.jsonl`);
  agent.coordinationInboxFile = inboxFile;

  const entry: AgentRegistryEntry = {
    sessionId: agent.sessionId,
    agentId: agent.id,
    providerId: agent.providerId,
    providerName: _providerName(agent.providerId),
    role: agent.role ?? null,
    roleDescription: agent.roleDescription ?? null,
    capabilities: agent.capabilities ?? [],
    status: 'idle',
    currentTask: null,
    inboxFile,
    registeredAt: Date.now(),
    updatedAt: Date.now(),
  };

  await writeAgentEntry(entry);
  const registry = await refreshRegistry();
  _sendRegistryToWebview(Object.values(registry.agents));
}

export async function deregisterAgent(sessionId: string): Promise<void> {
  await deleteAgentEntry(sessionId);
  await deleteInboxFile(sessionId);
  const registry = await refreshRegistry();
  _sendRegistryToWebview(Object.values(registry.agents));
}

// ── Status updates ────────────────────────────────────────────

export async function updateAgentStatus(
  sessionId: string,
  status: AgentRegistryEntry['status'],
  currentTask: string | null,
): Promise<void> {
  const agent = _findBySession(sessionId);
  if (!agent) return;

  const existing = await _readEntry(sessionId);
  if (!existing) return;

  existing.status = status;
  existing.currentTask = currentTask;
  existing.updatedAt = Date.now();
  await writeAgentEntry(existing);
}

// ── Role management ───────────────────────────────────────────

export async function updateAgentRole(
  agentId: number,
  role: string | null,
  roleDescription?: string,
  capabilities?: string[],
): Promise<void> {
  const agent = _agents?.get(agentId);
  if (!agent) return;

  agent.role = role ?? undefined;
  agent.roleDescription = roleDescription;
  agent.capabilities = capabilities;

  if (agent.sessionId) {
    const existing = await _readEntry(agent.sessionId);
    if (existing) {
      existing.role = role;
      existing.roleDescription = roleDescription ?? null;
      existing.capabilities = capabilities ?? [];
      existing.updatedAt = Date.now();
      await writeAgentEntry(existing);
      await refreshRegistry();
    }
  }

  _postMessage({
    type: 'coordination',
    subtype: 'roleUpdated',
    agentId,
    role,
    roleDescription,
    capabilities,
  });
}

// ── Stale agent cleanup ───────────────────────────────────────

export async function pruneStaleAgents(): Promise<void> {
  const pruned = await pruneStaleAgentFiles();
  if (pruned.length > 0) {
    const registry = await refreshRegistry();
    _sendRegistryToWebview(Object.values(registry.agents));
  }
}

// ── Task operations ───────────────────────────────────────────

export async function rollbackAgentTasks(sessionId: string): Promise<void> {
  await rollbackTasksForSession(sessionId);
  await _broadcastTaskUpdate();
}

export async function createSharedTask(
  createdByAgentId: number,
  title: string,
  body: string,
  priority = 3,
  requiredRole: string | null = null,
  dependsOn: string[] = [],
): Promise<SharedTask | null> {
  const agent = _agents?.get(createdByAgentId);
  if (!agent?.sessionId) return null;

  const task: SharedTask = {
    id: crypto.randomUUID(),
    title,
    body,
    status: 'pending',
    claimedBy: null,
    createdBy: agent.sessionId,
    dependsOn,
    requiredRole,
    priority,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await createTask(task);
  await _broadcastTaskUpdate();
  return task;
}

export function claimSharedTask(agentId: number, taskId: string): SharedTask | null {
  const agent = _agents?.get(agentId);
  if (!agent?.sessionId) return null;
  const task = claimTaskSync(taskId, agent.sessionId);
  if (task) void _broadcastTaskUpdate();
  return task;
}

export async function completeSharedTask(
  agentId: number,
  taskId: string,
  result?: string,
): Promise<void> {
  const agent = _agents?.get(agentId);
  if (!agent?.sessionId) return;
  await completeTask(taskId, agent.sessionId, result);
  await _broadcastTaskUpdate();
}

export async function failSharedTask(
  agentId: number,
  taskId: string,
  reason?: string,
): Promise<void> {
  const agent = _agents?.get(agentId);
  if (!agent?.sessionId) return;
  await failTask(taskId, agent.sessionId, reason);
  await _broadcastTaskUpdate();
}

export async function getTaskList(): Promise<SharedTask[]> {
  return listAllTasks();
}

// ── Registry broadcast to webview ────────────────────────────

export async function sendRegistryToWebview(): Promise<void> {
  const registry = await refreshRegistry();
  _sendRegistryToWebview(Object.values(registry.agents));
}

// ── Inbox message routing ─────────────────────────────────────

export async function processSendToMessages(agent: AgentState): Promise<void> {
  if (!agent.sessionId) return;

  const messages = await readNewInboxMessages(agent.sessionId);
  for (const msg of messages) {
    if (msg.type === 'send_to') {
      await _routeSendTo(msg, agent);
    } else if (msg.type === 'set_role') {
      await _handleSetRole(msg, agent);
    }
    // Other types (message, delegate, result, ack, decline) are consumed by the agent itself
  }
}

// ── Broadcast from extension UI ──────────────────────────────

export async function broadcastMessage(fromAgentId: number, body: string): Promise<void> {
  const fromAgent = _agents?.get(fromAgentId);
  if (!fromAgent?.sessionId) return;

  const fromEntry = await _readEntry(fromAgent.sessionId);
  if (!fromEntry) return;

  const registry = await refreshRegistry();
  const targets = Object.values(registry.agents).filter((e) => e.sessionId !== fromAgent.sessionId);

  for (const target of targets) {
    const msg: CoordinationMessage = buildRoutedMessage(
      {
        toSessionId: target.sessionId,
        type: 'broadcast',
        body,
        sentAt: Date.now(),
      },
      fromEntry,
    );
    await appendToInbox(target.sessionId, msg);
    _notifyWebviewArc(fromAgentId, target.agentId, 'broadcast', body);
  }
}

export async function sendDirectMessage(
  fromAgentId: number,
  toAgentId: number,
  body: string,
): Promise<void> {
  const fromAgent = _agents?.get(fromAgentId);
  const toAgent = _agents?.get(toAgentId);
  if (!fromAgent?.sessionId || !toAgent?.sessionId) return;

  const fromEntry = await _readEntry(fromAgent.sessionId);
  if (!fromEntry) return;

  const msg: CoordinationMessage = buildRoutedMessage(
    {
      toSessionId: toAgent.sessionId,
      type: 'message',
      body,
      sentAt: Date.now(),
    },
    fromEntry,
  );
  await appendToInbox(toAgent.sessionId, msg);
  _notifyWebviewArc(fromAgentId, toAgentId, 'message', body);
}

// ── Internal helpers ──────────────────────────────────────────

async function _poll(): Promise<void> {
  if (!_agents) return;
  await pruneStaleAgents();

  const recovered = await recoverTimedOutTasks();
  if (recovered.length > 0) {
    await _broadcastTaskUpdate();
  }

  for (const agent of _agents.values()) {
    if (agent.sessionId) {
      await processSendToMessages(agent);
    }
  }
}

async function _heartbeat(): Promise<void> {
  if (!_agents) return;
  const now = Date.now();
  for (const agent of _agents.values()) {
    if (!agent.sessionId) continue;
    const entry = await _readEntry(agent.sessionId);
    if (!entry) continue;
    entry.updatedAt = now;
    await writeAgentEntry(entry);
  }
}

async function _broadcastTaskUpdate(): Promise<void> {
  const tasks = await listAllTasks();
  _postMessage({ type: 'coordination', subtype: 'taskList', tasks });
}

async function _routeSendTo(rawMsg: CoordinationMessage, fromAgent: AgentState): Promise<void> {
  if (!fromAgent.sessionId) return;

  const fromEntry = await _readEntry(fromAgent.sessionId);
  if (!fromEntry) return;

  const routed = buildRoutedMessage(rawMsg, fromEntry);

  // Validate chain depth
  if ((routed.chainDepth ?? 0) > 5) {
    console.warn('[CoordManager] Chain depth exceeded, dropping message');
    return;
  }

  await appendToInbox(routed.toSessionId, routed);

  // Find target agent ID for webview arc
  const targetAgent = _findBySession(routed.toSessionId);
  if (targetAgent) {
    _notifyWebviewArc(fromAgent.id, targetAgent.id, routed.type, routed.body);
  }

  // Log the routing event
  const logEntry: CoordLogEntry = {
    timestamp: Date.now(),
    fromAgentId: fromAgent.id,
    toAgentId: targetAgent?.id ?? null,
    fromRole: fromAgent.role ?? null,
    msgType: routed.type,
    body: routed.body.substring(0, 200),
  };
  await appendHistory(logEntry);

  _postMessage({ type: 'coordination', subtype: 'log', events: [logEntry] });
}

async function _handleSetRole(msg: CoordinationMessage, agent: AgentState): Promise<void> {
  // body = role string, or JSON { role, description, capabilities }
  let role: string | null = null;
  let roleDescription: string | undefined;
  let capabilities: string[] | undefined;

  try {
    const parsed = JSON.parse(msg.body) as {
      role?: string;
      description?: string;
      capabilities?: string[];
    };
    role = parsed.role ?? null;
    roleDescription = parsed.description;
    capabilities = parsed.capabilities;
  } catch {
    role = msg.body.trim() || null;
  }

  await updateAgentRole(agent.id, role, roleDescription, capabilities);
}

function _notifyWebviewArc(
  fromId: number,
  toId: number,
  arcType: CoordinationMessage['type'],
  _body: string,
): void {
  _postMessage({
    type: 'coordination',
    subtype: 'arc',
    fromId,
    toId,
    arcType,
  });
}

function _postMessage(msg: Record<string, unknown>): void {
  _getWebview?.()?.postMessage(msg);
}

function _sendRegistryToWebview(agents: AgentRegistryEntry[]): void {
  _postMessage({ type: 'coordination', subtype: 'registry', agents });
}

function _findBySession(sessionId: string): AgentState | undefined {
  if (!_agents) return undefined;
  for (const agent of _agents.values()) {
    if (agent.sessionId === sessionId) return agent;
  }
  return undefined;
}

async function _readEntry(sessionId: string): Promise<AgentRegistryEntry | null> {
  return readAgentEntry(sessionId);
}

function _providerName(providerId: string): string {
  const names: Record<string, string> = {
    claude: 'Claude Code',
    gemini: 'Gemini CLI',
    openai: 'ChatGPT',
  };
  return names[providerId] ?? providerId;
}

// ── Coordination context message ──────────────────────────────

export function buildCoordContextMessage(sessionId: string): string {
  const coordDir = getCoordDir();
  const inboxPath = path.join(coordDir, 'inbox', `${sessionId}.jsonl`);
  const registryPath = path.join(coordDir, 'registry.json');

  const lines = [
    `[Pixel Agents] You are part of a multi-agent team.`,
    `  Session ID : ${sessionId}`,
    `  Your inbox : ${inboxPath}`,
    `  Team registry : ${registryPath}`,
    ``,
    `How to collaborate:`,
    `  Read messages : cat "$PIXEL_AGENTS_INBOX"`,
    `  See teammates : cat "$PIXEL_AGENTS_REGISTRY"`,
    `  Send message  : echo '{"type":"send_to","toSessionId":"TARGET_ID","msgType":"message","body":"hello","sentAt":'$(date +%s000)'}' >> "$PIXEL_AGENTS_INBOX"`,
    `  Declare role  : echo '{"type":"set_role","body":"Architect","sentAt":'$(date +%s000)'}' >> "$PIXEL_AGENTS_INBOX"`,
    ``,
    `Please check your inbox now for any pending messages before proceeding.`,
  ];

  return lines.join('\n');
}

// ── Env vars for PTY injection ────────────────────────────────

export function buildCoordEnv(sessionId: string): Record<string, string> {
  const coordDir = getCoordDir();
  return {
    PIXEL_AGENTS_SESSION_ID: sessionId,
    PIXEL_AGENTS_REGISTRY: path.join(coordDir, 'registry.json'),
    PIXEL_AGENTS_INBOX: path.join(coordDir, 'inbox', `${sessionId}.jsonl`),
    PIXEL_AGENTS_COORD_DIR: coordDir,
  };
}
