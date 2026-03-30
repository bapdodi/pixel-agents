import { exec } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

import {
  JSONL_POLL_INTERVAL_MS,
  TERMINAL_NAME_PREFIX,
  WORKSPACE_KEY_AGENT_SEATS,
  WORKSPACE_KEY_AGENTS,
} from './constants.js';
import { ensureProjectScan, readNewLines, startFileWatching } from './fileWatcher.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { getProvider } from './providers/index.js';
import { type AgentPty,spawnAgentPty } from './ptyManager.js';
import { cancelPermissionTimer, cancelWaitingTimer } from './timerManager.js';
import type { AgentState, PersistedAgent } from './types.js';
const execAsync = promisify(exec);

// Lazily create output channel
let _ptyOutputChannel: vscode.OutputChannel | undefined;
function getPtyOutputChannel(): vscode.OutputChannel {
  if (!_ptyOutputChannel) {
    _ptyOutputChannel = vscode.window.createOutputChannel('Pixel Agents PTY');
  }
  return _ptyOutputChannel;
}

/**
 * Returns the default base directory where Claude Code stores its project session folders.
 */
export function getProjectDirPath(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Helper to get the absolute path for 'claude' command on Windows
 */
async function resolveClaudeCommand(cmd: string): Promise<string> {
  if (os.platform() !== 'win32' || !cmd.startsWith('claude')) return cmd;
  try {
    const { stdout } = await execAsync('where.exe claude.cmd', { timeout: 2000 });
    const lines = stdout.split(/\r?\n/).filter((line: string) => line.trim().length > 0);
    const claudePath = lines[0]?.trim();
    return claudePath || cmd;
  } catch {
    return cmd;
  }
}

export async function launchNewTerminal(
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  getWebview: () => vscode.Webview | undefined,
  persistAgents: () => Promise<void>,
  options: {
    providerId?: string;
    folderPath?: string;
    bypassPermissions?: boolean;
  } = {},
): Promise<void> {
  const { providerId = 'claude', folderPath, bypassPermissions } = options;
  const folders = vscode.workspace.workspaceFolders;
  const provider = getProvider(providerId);
  const id = nextAgentIdRef.current++;
  
  // Phase 1: Notify UI immediately to prevent "WAITING FOR AGENT CONNECTION" hang
  const cwd = folderPath || folders?.[0]?.uri.fsPath || os.homedir();
  const folderName = folders && folders.length > 1 && cwd ? path.basename(cwd) : undefined;
  
  console.log(`[AgentManager] 🟢 Phase 1: Notifying UI for Agent ${id}`);
  getWebview()?.postMessage({ type: 'agentCreated', id, folderName, providerId });

  // Phase 2: Deferred PTY spawning to keep extension host responsive
  setTimeout(async () => {
    try {
      console.log(`[AgentManager] 🟡 Phase 2: Building Agent ${id} infrastructure...`);
      const sessionId = crypto.randomUUID();
      const cmd = await provider.buildCommand(sessionId, { bypassPermissions });
      const resolvedCmd = await resolveClaudeCommand(cmd);
      const projectDir = await provider.getProjectDir(cwd);
      const expectedFile = await provider.getExpectedFile(projectDir, sessionId);
      knownJsonlFiles.add(expectedFile);

      const isWin = os.platform() === 'win32';
      const shell = isWin ? (process.env.ComSpec || 'cmd.exe') : 'bash';
      // Pass the resolved command as a single argument to /c; node-pty handles quoting if spaces are present
      const shellArgs = isWin ? ['/c', resolvedCmd] : ['-c', resolvedCmd];
      
      console.log(`[AgentManager] 🚀 Spawning Agent ${id} PTY via ${shell} ${JSON.stringify(shellArgs)}`);

      const ptyInstance: AgentPty | null = spawnAgentPty(
        id,
        shell,
        shellArgs,
        cwd,
        (data) => {
          const b64 = Buffer.from(data).toString('base64');
          const wv = getWebview();
          if (!wv) {
            console.warn(`[AgentManager] ⚠️ Webview is UNDEFINED for Agent ${id}. Data chunk of ${b64.length} dropped.`);
          } else {
            wv.postMessage({ type: 'agentTerminalData', id, data: b64 });
          }

          const a = agents.get(id);
          if (a) {
            a.terminalBuffer.push(b64);
            if (a.terminalBuffer.length > 1000) a.terminalBuffer.shift();
          }
        },
      );

      const agent: AgentState = {
        id,
        terminalRef: undefined,
        projectDir,
        jsonlFile: expectedFile,
        fileOffset: 0,
        lineBuffer: '',
        activeToolIds: new Set(),
        activeToolStatuses: new Map(),
        activeToolNames: new Map(),
        activeSubagentToolIds: new Map(),
        activeSubagentToolNames: new Map(),
        backgroundAgentToolIds: new Set(),
        isWaiting: false,
        permissionSent: false,
        hadToolsInTurn: false,
        lastDataAt: Date.now(),
        linesProcessed: 0,
        seenUnknownRecordTypes: new Set(),
        folderName,
        providerId,
        pty: ptyInstance,
        terminalBuffer: [],
      };

      if (ptyInstance) ptyInstance.id = id;
      agents.set(id, agent);
      activeAgentIdRef.current = id;
      await persistAgents();

      console.log(`[AgentManager] 🔵 Phase 3: Project scan and JSONL polling for Agent ${id}`);
      await ensureProjectScan(
        projectDir,
        knownJsonlFiles,
        projectScanTimerRef,
        activeAgentIdRef,
        nextAgentIdRef,
        agents,
        fileWatchers,
        pollingTimers,
        waitingTimers,
        permissionTimers,
        getWebview,
        persistAgents,
      );

      // Final poll for JSONL file
      let pollCount = 0;
      const pollTimer = setInterval(async () => {
        pollCount++;
        try {
          const exists = await fs.promises.access(agent.jsonlFile, fs.constants.F_OK).then(() => true).catch(() => false);
          if (exists) {
            clearInterval(pollTimer);
            jsonlPollTimers.delete(id);
            startFileWatching(id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, getWebview);
            await readNewLines(id, agents, waitingTimers, permissionTimers, getWebview);
          } else if (pollCount === 20) {
            console.warn(`[AgentManager] Agent ${id}: Timeout waiting for JSONL at ${path.basename(agent.jsonlFile)}`);
          }
        } catch { /* ignore */ }
      }, JSONL_POLL_INTERVAL_MS);
      jsonlPollTimers.set(id, pollTimer);

    } catch (err) {
      console.error(`[AgentManager] ❌ CRITICAL: Failed to build Agent ${id}:`, err);
    }
  }, 10);
}

export async function removeAgent(
  agentId: number,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  persistAgents: () => Promise<void>,
): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) return;

  const jpTimer = jsonlPollTimers.get(agentId);
  if (jpTimer) clearInterval(jpTimer);
  jsonlPollTimers.delete(agentId);

  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  
  const pt = pollingTimers.get(agentId);
  if (pt) clearInterval(pt);
  pollingTimers.delete(agentId);

  // Clear activity
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);

  agents.delete(agentId);
  await persistAgents();
}

export async function persistAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
): Promise<void> {
  const persisted: PersistedAgent[] = [];
  for (const agent of agents.values()) {
    persisted.push({
      id: agent.id,
      terminalName: agent.terminalRef?.name || `Agent #${agent.id}`,
      jsonlFile: agent.jsonlFile,
      projectDir: agent.projectDir,
      folderName: agent.folderName,
      providerId: agent.providerId,
    });
  }
  await context.workspaceState.update(WORKSPACE_KEY_AGENTS, persisted);
}

export async function restoreAgents(
  context: vscode.ExtensionContext,
  nextAgentIdRef: { current: number },
  nextTerminalIndexRef: { current: number },
  agents: Map<number, AgentState>,
  knownJsonlFiles: Set<string>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  getWebview: () => vscode.Webview | undefined,
  doPersist: () => Promise<void>,
): Promise<void> {
  const persisted = context.workspaceState.get<PersistedAgent[]>(WORKSPACE_KEY_AGENTS, []);
  if (persisted.length === 0) return;

  const liveTerminals = vscode.window.terminals;
  let maxId = 0;
  let maxIdx = 0;
  let restoredProjectDir: string | null = null;

  for (const p of persisted) {
    const terminal = liveTerminals.find((t) => t.name === p.terminalName);
    if (!terminal) continue;

    const agent: AgentState = {
      id: p.id,
      terminalRef: terminal,
      projectDir: p.projectDir,
      jsonlFile: p.jsonlFile,
      fileOffset: 0,
      lineBuffer: '',
      activeToolIds: new Set(),
      activeToolStatuses: new Map(),
      activeToolNames: new Map(),
      activeSubagentToolIds: new Map(),
      activeSubagentToolNames: new Map(),
      backgroundAgentToolIds: new Set(),
      isWaiting: false,
      permissionSent: false,
      hadToolsInTurn: false,
      lastDataAt: Date.now(),
      linesProcessed: 0,
      seenUnknownRecordTypes: new Set(),
      folderName: p.folderName,
      providerId: p.providerId,
      terminalBuffer: [],
    };

    agents.set(p.id, agent);
    knownJsonlFiles.add(p.jsonlFile);

    if (p.id > maxId) maxId = p.id;
    const match = p.terminalName.match(/#(\d+)$/);
    if (match) {
      const idx = parseInt(match[1], 10);
      if (idx > maxIdx) maxIdx = idx;
    }

    restoredProjectDir = p.projectDir;

    try {
      const fileExists = await fs.promises.access(p.jsonlFile, fs.constants.F_OK).then(() => true).catch(() => false);
      if (fileExists) {
        const stat = await fs.promises.stat(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(p.id, p.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, getWebview);
      } else {
        const pollTimer = setInterval(async () => {
          const exists = await fs.promises.access(agent.jsonlFile, fs.constants.F_OK).then(() => true).catch(() => false);
          if (exists) {
            clearInterval(pollTimer);
            jsonlPollTimers.delete(p.id);
            const stat = await fs.promises.stat(agent.jsonlFile);
            agent.fileOffset = stat.size;
            startFileWatching(p.id, agent.jsonlFile, agents, fileWatchers, pollingTimers, waitingTimers, permissionTimers, getWebview);
          }
        }, JSONL_POLL_INTERVAL_MS);
        jsonlPollTimers.set(p.id, pollTimer);
      }
    } catch { /* ignore */ }
  }

  if (maxId >= nextAgentIdRef.current) nextAgentIdRef.current = maxId + 1;
  if (maxIdx >= nextTerminalIndexRef.current) nextTerminalIndexRef.current = maxIdx + 1;

  await doPersist();

  if (restoredProjectDir) {
    await ensureProjectScan(
      restoredProjectDir,
      knownJsonlFiles,
      projectScanTimerRef,
      activeAgentIdRef,
      nextAgentIdRef,
      agents,
      fileWatchers,
      pollingTimers,
      waitingTimers,
      permissionTimers,
      getWebview,
      doPersist,
    );
  }
}

export async function sendExistingAgents(
  agents: Map<number, AgentState>,
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
): Promise<void> {
  if (!webview) return;
  const agentIds = Array.from(agents.keys()).sort((a, b) => a - b);
  const savedMeta = context.workspaceState.get<Record<string, any>>(WORKSPACE_KEY_AGENT_SEATS, {});
  const agentMeta = { ...savedMeta };

  for (const [id, agent] of agents) {
    if (!agentMeta[id]) agentMeta[id] = {};
    agentMeta[id].providerId = agent.providerId;
  }

  const folderNames: Record<number, string> = {};
  for (const [id, agent] of agents) {
    if (agent.folderName) folderNames[id] = agent.folderName;
  }

  webview.postMessage({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta,
    folderNames,
  });

  sendCurrentAgentStatuses(agents, webview);
}

export function sendCurrentAgentStatuses(
  agents: Map<number, AgentState>,
  webview: vscode.Webview | undefined,
): void {
  if (!webview) return;
  for (const [agentId, agent] of agents) {
    for (const [toolId, status] of agent.activeToolStatuses) {
      webview.postMessage({ type: 'agentToolStart', id: agentId, toolId, status });
    }
    if (agent.isWaiting) {
      webview.postMessage({ type: 'agentStatus', id: agentId, status: 'waiting' });
    }
  }
}

export async function sendLayout(
  context: vscode.ExtensionContext,
  webview: vscode.Webview | undefined,
  defaultLayout?: Record<string, unknown> | null,
): Promise<void> {
  if (!webview) return;
  const result = await migrateAndLoadLayout(context, defaultLayout);
  webview.postMessage({
    type: 'layoutLoaded',
    layout: result?.layout ?? null,
    wasReset: result?.wasReset ?? false,
  });
}

export function sendTextToTerminal(
  agentId: number,
  text: string,
  agents: Map<number, AgentState>,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;
  
  try {
    if (agent.terminalRef) {
      agent.terminalRef.sendText(text);
    } else {
      agent.pty?.ptyProcess.write(text + '\n');
    }
  } catch (err: any) {
    console.error(`[Pixel Agents] Failed to send text for Agent ${agentId}:`, err);
  }
}
