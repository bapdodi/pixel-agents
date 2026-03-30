import type * as ptyTypes from 'node-pty';
import * as os from 'os';
import * as vscode from 'vscode';

export interface AgentPty {
  id: number;
  ptyProcess: ptyTypes.IPty;
  onData: (data: string) => void;
  dispose: () => void;
}

const ptyInstances = new Map<number, AgentPty>();

function getPtyOutputChannel(): { appendLine: (msg: string) => void } {
  // Disable real output channel in Antigravity to avoid synchronous hangs
  return {
    appendLine: (msg: string) => {
      console.log(`[PTY Output] ${msg}`);
    }
  };
}

// Lazy-load node-pty so a load failure doesn't crash the entire extension
let ptyModule: typeof ptyTypes | null = null;
let ptyLoadError: string | null = null;

function loadPty(): typeof ptyTypes | null {
  console.log('[PTY] Loading node-pty...');
  if (ptyModule) {
    console.log('[PTY] node-pty already loaded');
    return ptyModule;
  }
  if (ptyLoadError) {
    console.log(`[PTY] node-pty load previously failed: ${ptyLoadError}`);
    return null;
  }
  try {
     
    ptyModule = require('node-pty') as typeof ptyTypes;
    console.log('[PTY] node-pty loaded successfully via require');
    getPtyOutputChannel().appendLine('[PTY] node-pty loaded successfully');
    return ptyModule;
  } catch (err: unknown) {
    ptyLoadError = err instanceof Error ? err.message : String(err);
    console.error(`[PTY] Failed to load node-pty: ${ptyLoadError}`);
    getPtyOutputChannel().appendLine(`[PTY ERROR] Failed to load node-pty: ${ptyLoadError}`);
    return null;
  }
}

export function spawnAgentPty(
  id: number,
  command: string,
  args: string[],
  cwd: string,
  onData: (data: string) => void,
): AgentPty | null {
  const pty = loadPty();
  if (!pty) {
    getPtyOutputChannel().appendLine(`[Agent ${id}] Cannot spawn PTY: node-pty unavailable (${ptyLoadError})`);
    return null;
  }

  const ptyPath = process.env.Path || process.env.PATH || '';
  const comSpec = process.env.ComSpec || 'cmd.exe';

  const ptyEnv = {
    ...process.env,
    ComSpec: comSpec,
    Path: ptyPath,
    FORCE_COLOR: '1',
    TERM: 'xterm-256color',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    VSCODE_TERMINAL: '1',
  };

  let ptyProcess: ptyTypes.IPty;
  try {
    const outChannel = getPtyOutputChannel();
    outChannel.appendLine(`[Agent ${id}] Spawning PTY: ${command} ${JSON.stringify(args)}`);
    console.log(`[PTY] Spawning: ${command} ${JSON.stringify(args)} (cwd: ${cwd})`);
    
    const isWin = os.platform() === 'win32';
    
    ptyProcess = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
      cwd,
      env: ptyEnv as Record<string, string>,
      ...(isWin ? { useConpty: false, experimentalUseConpty: false } : {}),
    });
    console.log(`[PTY] Process spawned successfully (pid: ${ptyProcess.pid})`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[PTY] Spawn ERROR: ${msg}`);
    getPtyOutputChannel().appendLine(`[Agent ${id}] PTY spawn failed: ${msg}`);
    return null;
  }

  const agentPty: AgentPty = {
    id,
    ptyProcess,
    onData,
    dispose: () => {
      try { 
        console.log(`[PTY] Killing process ${ptyProcess.pid} for Agent ${id}`);
        ptyProcess.kill(); 
      } catch { /* ignore */ }
      ptyInstances.delete(id);
    },
  };

  ptyProcess.onData((data: string) => {
    if (data.length > 0) {
      console.log(`[PTY] Agent ${id} RECEIVED ${data.length} bytes: ${JSON.stringify(data.substring(0, 50))}...`);
    }
    onData(data);
  });

  ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    console.log(`[PTY] Agent ${id} EXITED: code=${exitCode}, signal=${signal}`);
    getPtyOutputChannel().appendLine(`[Agent ${id}] PTY EXIT: code=${exitCode}, signal=${signal}`);
  });

  ptyInstances.set(id, agentPty);
  return agentPty;
}

export function getAgentPty(id: number): AgentPty | undefined {
  return ptyInstances.get(id);
}

export function writeToAgentPty(id: number, data: string): void {
  const agentPty = ptyInstances.get(id);
  if (agentPty) {
    agentPty.ptyProcess.write(data);
  }
}

export function resizeAgentPty(id: number, cols: number, rows: number): void {
  const agentPty = ptyInstances.get(id);
  if (agentPty) {
    agentPty.ptyProcess.resize(cols, rows);
  }
}
