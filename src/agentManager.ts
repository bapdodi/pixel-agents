import { exec } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

import {
  COORD_CONTEXT_INJECT_DELAY_MS,
  JSONL_POLL_INTERVAL_MS,
  WORKSPACE_KEY_AGENT_SEATS,
  WORKSPACE_KEY_AGENTS,
} from './constants.js';
import {
  buildCoordContextMessage,
  buildCoordEnv,
  deregisterAgent,
  initCoordination,
  registerAgent,
} from './coordinationManager.js';
import { ensureProjectScan, readNewLines, startFileWatching } from './fileWatcher.js';
import { migrateAndLoadLayout } from './layoutPersistence.js';
import { getProvider } from './providers/index.js';
import { type AgentPty, spawnAgentPty } from './ptyManager.js';
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
    role?: string;
    roleDescription?: string;
    capabilities?: string[];
    extensionPath?: string;
  } = {},
): Promise<void> {
  const {
    providerId = 'claude',
    folderPath,
    bypassPermissions,
    role,
    roleDescription,
    capabilities,
    extensionPath,
  } = options;
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
      const shell = isWin ? process.env.ComSpec || 'cmd.exe' : 'bash';
      // Pass the resolved command as a single argument to /c; node-pty handles quoting if spaces are present
      const shellArgs = isWin ? ['/c', resolvedCmd] : ['-c', resolvedCmd];

      console.log(
        `[AgentManager] 🚀 Spawning Agent ${id} PTY via ${shell} ${JSON.stringify(shellArgs)}`,
      );

      const coordEnv = buildCoordEnv(sessionId, extensionPath);

      const ptyInstance: AgentPty | null = spawnAgentPty(
        id,
        shell,
        shellArgs,
        cwd,
        (data) => {
          const wv = getWebview();
          const a = agents.get(id);
          if (!a) return;

          // Convert raw data to string (strip some ANSI or handle as-is)
          const chunk = data;
          a.lineBuffer += chunk;

          // Dynamic Session ID Detection (e.g. for Gemini)
          if (!a.jsonlFileResolved && provider.getSessionIdRegex) {
            const regex = provider.getSessionIdRegex();
            const match = a.lineBuffer.match(regex);
            if (match) {
              const realSessionId = match[1];
              console.log(
                `[AgentManager] 🎯 Detected Session ID for Agent ${id}: ${realSessionId}`,
              );

              // Resolve the actual file path
              provider.getExpectedFile(a.projectDir, realSessionId).then((actualFile) => {
                a.jsonlFile = actualFile;
                a.jsonlFileResolved = true;
                knownJsonlFiles.add(actualFile);

                // Start polling/watching now that we have the real file
                startGeminiPolling(
                  id,
                  agents,
                  jsonlPollTimers,
                  fileWatchers,
                  pollingTimers,
                  waitingTimers,
                  permissionTimers,
                  getWebview,
                );
                persistAgents();
              });
            }
          }

          if (a.lineBuffer.includes('\n') || a.lineBuffer.length > 500) {
            const lines = a.lineBuffer.split(/\r?\n/);
            // Keep the last partial line in the buffer
            a.lineBuffer = lines.pop() || '';

            for (const line of lines) {
              if (line.trim().length > 0) {
                wv?.postMessage({
                  type: 'agentTerminalText',
                  id,
                  content: line.replace(
                    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
                    '',
                  ),
                  streamType: 'shell',
                });
              }
            }
          }

          // Send raw string data to prevent character corruption from chunked Base64
          a.terminalBuffer.push(data);
          if (a.terminalBuffer.length > 500) a.terminalBuffer.shift();

          wv?.postMessage({ type: 'agentTerminalData', id, data });
        },
        coordEnv,
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
        jsonlFileResolved: !provider.getSessionIdRegex, // Immediate for Claude, deferred for Gemini
        sessionId,
        role,
        roleDescription,
        capabilities,
      };

      if (ptyInstance) ptyInstance.id = id;
      agents.set(id, agent);
      activeAgentIdRef.current = id;
      await persistAgents();
      await registerAgent(agent);

      // Inject coordination context into PTY after startup settles
      if (agent.pty && (providerId === 'claude' || providerId === 'gemini')) {
        const capturedPty = agent.pty;
        setTimeout(() => {
          try {
            const msg = buildCoordContextMessage(agent);
            capturedPty.ptyProcess.write(msg + '\r');
          } catch (e) {
            console.warn('[AgentManager] Failed to inject coord context:', e);
          }
        }, COORD_CONTEXT_INJECT_DELAY_MS);
      }

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

      // Start polling only if resolution is already done (Claude)
      if (agent.jsonlFileResolved) {
        startGeminiPolling(
          id,
          agents,
          jsonlPollTimers,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          getWebview,
        );
      }
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

  if (agent.sessionId) {
    await deregisterAgent(agent.sessionId);
  }

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
      role: agent.role,
      roleDescription: agent.roleDescription,
      capabilities: agent.capabilities,
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
      jsonlFileResolved: true, // Restored agents are always resolved
      role: p.role,
      roleDescription: p.roleDescription,
      capabilities: p.capabilities,
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
      const fileExists = await fs.promises
        .access(p.jsonlFile, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false);
      if (fileExists) {
        const stat = await fs.promises.stat(p.jsonlFile);
        agent.fileOffset = stat.size;
        startFileWatching(
          p.id,
          p.jsonlFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          getWebview,
        );
      } else {
        const pollTimer = setInterval(async () => {
          const exists = await fs.promises
            .access(agent.jsonlFile, fs.constants.F_OK)
            .then(() => true)
            .catch(() => false);
          if (exists) {
            clearInterval(pollTimer);
            jsonlPollTimers.delete(p.id);
            const stat = await fs.promises.stat(agent.jsonlFile);
            agent.fileOffset = stat.size;
            startFileWatching(
              p.id,
              agent.jsonlFile,
              agents,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              getWebview,
            );
          }
        }, JSONL_POLL_INTERVAL_MS);
        jsonlPollTimers.set(p.id, pollTimer);
      }
    } catch {
      /* ignore */
    }
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

/**
 * Shared polling logic for Gemini and Claude
 */
function startGeminiPolling(
  id: number,
  agents: Map<number, AgentState>,
  jsonlPollTimers: Map<number, ReturnType<typeof setInterval>>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  getWebview: () => vscode.Webview | undefined,
) {
  const agent = agents.get(id);
  if (!agent) return;

  const pollTimer = setInterval(async () => {
    try {
      const exists = await fs.promises
        .access(agent.jsonlFile, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false);
      if (exists) {
        clearInterval(pollTimer);
        jsonlPollTimers.delete(id);
        startFileWatching(
          id,
          agent.jsonlFile,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          getWebview,
        );
        await readNewLines(id, agents, waitingTimers, permissionTimers, getWebview);
      }
    } catch {
      /* ignore */
    }
  }, JSONL_POLL_INTERVAL_MS);
  jsonlPollTimers.set(id, pollTimer);
}
