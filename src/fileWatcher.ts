import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import { FILE_WATCHER_POLL_INTERVAL_MS, PROJECT_SCAN_INTERVAL_MS } from './constants.js';
import { cancelPermissionTimer, cancelWaitingTimer, clearAgentActivity } from './timerManager.js';
import { processTranscriptLine } from './transcriptParser.js';
import type { AgentState } from './types.js';

export function startFileWatching(
  agentId: number,
  filePath: string,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  getWebview: () => vscode.Webview | undefined,
): void {
  // Single polling approach: reliable on all platforms (macOS, Linux, WSL2, Windows).
  // Previously used triple-redundant fs.watch + fs.watchFile + setInterval, but
  // fs.watch is unreliable on macOS/WSL2 and the redundancy created 3 timers per
  // agent doing synchronous I/O. The manual poll at 500ms is fast enough for a
  // pixel art visualization and works everywhere.
  const interval = setInterval(() => {
    if (!agents.has(agentId)) {
      clearInterval(interval);
      return;
    }
    readNewLines(agentId, agents, waitingTimers, permissionTimers, getWebview);
  }, FILE_WATCHER_POLL_INTERVAL_MS);
  pollingTimers.set(agentId, interval);
}

export async function readNewLines(
  agentId: number,
  agents: Map<number, AgentState>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  getWebview: () => vscode.Webview | undefined,
): Promise<void> {
  const agent = agents.get(agentId);
  if (!agent) return;
  let fd: fs.promises.FileHandle | null = null;
  try {
    const stat = await fs.promises.stat(agent.jsonlFile);
    if (stat.size <= agent.fileOffset) return;

    // Cap single read at 64KB to prevent blocking on massive JSONL dumps.
    const MAX_READ_BYTES = 65536;
    const bytesToRead = Math.min(stat.size - agent.fileOffset, MAX_READ_BYTES);
    const buf = Buffer.alloc(bytesToRead);

    fd = await fs.promises.open(agent.jsonlFile, 'r');
    await fd.read(buf, 0, buf.length, agent.fileOffset);

    agent.fileOffset += bytesToRead;

    const text = agent.lineBuffer + buf.toString('utf-8');
    const lines = text.split('\n');
    agent.lineBuffer = lines.pop() || '';

    const hasLines = lines.some((l) => l.trim());
    if (hasLines) {
      // New data arriving — cancel timers
      cancelWaitingTimer(agentId, waitingTimers);
      cancelPermissionTimer(agentId, permissionTimers);
      if (agent.permissionSent) {
        agent.permissionSent = false;
        getWebview()?.postMessage({ type: 'agentToolPermissionClear', id: agentId });
      }
    }

    for (const line of lines) {
      if (!line.trim()) continue;
      processTranscriptLine(agentId, line, agents, waitingTimers, permissionTimers, getWebview);
    }
  } catch (e) {
    if ((e as any).code !== 'ENOENT') {
      console.log(`[Pixel Agents] Read error for agent ${agentId}: ${e}`);
    }
  } finally {
    if (fd) {
      await fd.close();
    }
  }
}

export async function ensureProjectScan(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  projectScanTimerRef: { current: ReturnType<typeof setInterval> | null },
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  getWebview: () => vscode.Webview | undefined,
  persistAgents: () => void,
): Promise<void> {
  if (projectScanTimerRef.current) return;
  // Seed with all existing JSONL files
  try {
    const files = (await fs.promises.readdir(projectDir))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
    for (const f of files) {
      knownJsonlFiles.add(f);
    }
  } catch {
    /* dir may not exist yet */
  }

  let isScanning = false;
  projectScanTimerRef.current = setInterval(async () => {
    if (isScanning) return;
    isScanning = true;
    try {
      await scanForNewJsonlFiles(
        projectDir,
        knownJsonlFiles,
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
    } finally {
      isScanning = false;
    }
  }, PROJECT_SCAN_INTERVAL_MS);
}

async function scanForNewJsonlFiles(
  projectDir: string,
  knownJsonlFiles: Set<string>,
  activeAgentIdRef: { current: number | null },
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  getWebview: () => vscode.Webview | undefined,
  persistAgents: () => void,
): Promise<void> {
  let files: string[];
  try {
    files = (await fs.promises.readdir(projectDir))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(projectDir, f));
  } catch {
    return;
  }

  for (const file of files) {
    if (!knownJsonlFiles.has(file)) {
      knownJsonlFiles.add(file);
      if (activeAgentIdRef.current !== null) {
        // Active agent focused → /clear reassignment
        console.log(
          `[Pixel Agents] New JSONL detected: ${path.basename(file)}, reassigning to agent ${activeAgentIdRef.current}`,
        );
        reassignAgentToFile(
          activeAgentIdRef.current,
          file,
          agents,
          fileWatchers,
          pollingTimers,
          waitingTimers,
          permissionTimers,
          getWebview,
          persistAgents,
        );
      } else {
        // No active agent → try to adopt the focused terminal
        const activeTerminal = vscode.window.activeTerminal;
        if (activeTerminal) {
          let owned = false;
          for (const agent of agents.values()) {
            if (agent.terminalRef === activeTerminal) {
              owned = true;
              break;
            }
          }
          if (!owned) {
            adoptTerminalForFile(
              activeTerminal,
              file,
              projectDir,
              nextAgentIdRef,
              agents,
              activeAgentIdRef,
              fileWatchers,
              pollingTimers,
              waitingTimers,
              permissionTimers,
              getWebview,
              persistAgents,
            );
          }
        } else {
          console.log(
            `[Pixel Agents] New JSONL detected but no active agent or terminal to adopt: ${path.basename(file)}`,
          );
        }
      }
    }
  }

  // Clean up orphaned agents whose terminals have been closed
  for (const [id, agent] of agents) {
    if (agent.terminalRef && agent.terminalRef.exitStatus !== undefined) {
      console.log(`[Pixel Agents] Agent ${id}: terminal closed, cleaning up orphan`);
      // Stop file watching
      fileWatchers.get(id)?.close();
      fileWatchers.delete(id);
      const pt = pollingTimers.get(id);
      if (pt) {
        clearInterval(pt);
      }
      pollingTimers.delete(id);
      cancelWaitingTimer(id, waitingTimers);
      cancelPermissionTimer(id, permissionTimers);
      agents.delete(id);
      persistAgents();
      getWebview()?.postMessage({ type: 'agentClosed', id });
    }
  }
}

function adoptTerminalForFile(
  terminal: vscode.Terminal,
  jsonlFile: string,
  projectDir: string,
  nextAgentIdRef: { current: number },
  agents: Map<number, AgentState>,
  activeAgentIdRef: { current: number | null },
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  getWebview: () => vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  const id = nextAgentIdRef.current++;
  const agent: AgentState = {
    id,
    terminalRef: terminal,
    projectDir,
    jsonlFile,
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
    lastDataAt: 0,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    providerId: 'claude',
    terminalBuffer: [],
    jsonlFileResolved: true,
  };

  agents.set(id, agent);
  activeAgentIdRef.current = id;
  persistAgents();

  console.log(
    `[Pixel Agents] Agent ${id}: adopted terminal "${terminal.name}" for ${path.basename(jsonlFile)}`,
  );
  getWebview()?.postMessage({ type: 'agentCreated', id });

  startFileWatching(
    id,
    jsonlFile,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    getWebview,
  );
  readNewLines(id, agents, waitingTimers, permissionTimers, getWebview);
}

export function reassignAgentToFile(
  agentId: number,
  newFilePath: string,
  agents: Map<number, AgentState>,
  fileWatchers: Map<number, fs.FSWatcher>,
  pollingTimers: Map<number, ReturnType<typeof setInterval>>,
  waitingTimers: Map<number, ReturnType<typeof setTimeout>>,
  permissionTimers: Map<number, ReturnType<typeof setTimeout>>,
  getWebview: () => vscode.Webview | undefined,
  persistAgents: () => void,
): void {
  const agent = agents.get(agentId);
  if (!agent) return;

  // Stop old file watching
  fileWatchers.get(agentId)?.close();
  fileWatchers.delete(agentId);
  const pt = pollingTimers.get(agentId);
  if (pt) {
    clearInterval(pt);
  }
  pollingTimers.delete(agentId);

  // Clear activity
  cancelWaitingTimer(agentId, waitingTimers);
  cancelPermissionTimer(agentId, permissionTimers);
  clearAgentActivity(agent, agentId, permissionTimers, getWebview);

  // Swap to new file
  agent.jsonlFile = newFilePath;
  agent.fileOffset = 0;
  agent.lineBuffer = '';
  persistAgents();

  // Start watching new file
  startFileWatching(
    agentId,
    newFilePath,
    agents,
    fileWatchers,
    pollingTimers,
    waitingTimers,
    permissionTimers,
    getWebview,
  );
  readNewLines(agentId, agents, waitingTimers, permissionTimers, getWebview);
}
