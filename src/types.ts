import type * as vscode from 'vscode';

import type { AgentPty } from './ptyManager.js';

// ── A2A Coordination Types ────────────────────────────────────

export interface AgentRegistryEntry {
  sessionId: string;
  agentId: number;
  providerId: string;
  providerName: string;
  role: string | null;
  roleDescription: string | null;
  capabilities: string[];
  status: 'active' | 'waiting' | 'idle';
  currentTask: string | null;
  inboxFile: string;
  registeredAt: number;
  updatedAt: number;
}

export interface CoordinationRegistry {
  version: 1;
  agents: Record<string, AgentRegistryEntry>;
  updatedAt: number;
}

export type CoordinationMessageType =
  | 'message'
  | 'delegate'
  | 'result'
  | 'broadcast'
  | 'send_to'
  | 'set_role'
  | 'spawn_agent'
  | 'decline'
  | 'ack';

export interface CoordinationMessage {
  id: string;
  fromSessionId: string;
  fromProviderId: string;
  fromRole: string | null;
  toSessionId: string;
  type: CoordinationMessageType;
  body: string;
  taskId?: string;
  chainDepth?: number;
  rootMessageId?: string;
  sentAt: number;
  ttl?: number;
}

export interface CoordLogEntry {
  timestamp: number;
  fromAgentId: number;
  toAgentId: number | null;
  fromRole: string | null;
  msgType: CoordinationMessageType;
  body: string;
}

export type SharedTaskStatus =
  | 'pending'
  | 'blocked'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'declined'
  | 'timed_out';

export interface SharedTask {
  id: string;
  title: string;
  body: string;
  status: SharedTaskStatus;
  claimedBy: string | null;
  createdBy: string;
  dependsOn: string[];
  requiredRole: string | null;
  priority: number; // 1 (high) – 5 (low)
  result?: string;
  assignedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentState {
  id: number;
  terminalRef: vscode.Terminal | undefined;
  projectDir: string;
  jsonlFile: string;
  fileOffset: number;
  lineBuffer: string;
  activeToolIds: Set<string>;
  activeToolStatuses: Map<string, string>;
  activeToolNames: Map<string, string>;
  activeSubagentToolIds: Map<string, Set<string>>; // parentToolId → active sub-tool IDs
  activeSubagentToolNames: Map<string, Map<string, string>>; // parentToolId → (subToolId → toolName)
  backgroundAgentToolIds: Set<string>; // tool IDs for run_in_background Agent calls (stay alive until queue-operation)
  isWaiting: boolean;
  permissionSent: boolean;
  hadToolsInTurn: boolean;
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;
  /** Timestamp of last JSONL data received (ms since epoch) */
  lastDataAt: number;
  /** Total JSONL lines processed for this agent */
  linesProcessed: number;
  /** Set of record.type values we've already warned about (prevents log spam) */
  seenUnknownRecordTypes: Set<string>;
  /** Provider ID for this agent (e.g. 'claude', 'openai', 'gemini') */
  providerId: string;
  /** Virtual terminal instance for real-time embedding */
  pty?: AgentPty | null;
  /** Buffer of raw terminal data (Base64) to replay on webview reconnect */
  terminalBuffer: string[];
  /** Whether the JSONL file path has been resolved (true for Claude, deferred for Gemini) */
  jsonlFileResolved: boolean;
  /** A2A: whether coordination context has been injected into PTY */
  coordContextInjected?: boolean;
  /** A2A: session UUID derived from jsonlFile basename */
  sessionId?: string;
  /** A2A: assigned role */
  role?: string;
  /** A2A: role description */
  roleDescription?: string;
  /** A2A: capability tags */
  capabilities?: string[];
  /** A2A: inbox file path */
  coordinationInboxFile?: string;
}

export interface PersistedAgent {
  id: number;
  terminalName: string;
  jsonlFile: string;
  projectDir: string;
  /** Workspace folder name (only set for multi-root workspaces) */
  folderName?: string;
  /** Provider ID for this agent */
  providerId: string;
  /** A2A: assigned role */
  role?: string;
  /** A2A: role description */
  roleDescription?: string;
  /** A2A: capability tags */
  capabilities?: string[];
}
