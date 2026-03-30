import type * as vscode from 'vscode';

export type AgentEventType = 
  | 'tool_start' 
  | 'tool_done' 
  | 'status_change' 
  | 'subagent_tool_start' 
  | 'subagent_tool_done' 
  | 'subagent_clear'
  | 'tools_clear'
  | 'turn_start'
  | 'turn_end'
  | 'text'
  | 'shell';

export interface AgentEvent {
  type: AgentEventType;
  toolId?: string;
  toolName?: string;
  status?: string;
  parentToolId?: string;
  id?: number; // agentId
  content?: string;
}

export interface AIProvider {
  /** Unique ID for the provider (e.g. 'claude', 'openai', 'gemini') */
  readonly id: string;
  /** Display name (e.g. 'Claude Code', 'OpenAI Codex', 'Gemini') */
  readonly name: string;
  /** Default command prefix if needed */
  readonly terminalPrefix: string;

  /** Build the command to launch in the terminal */
  buildCommand(sessionId: string, options: { bypassPermissions?: boolean }): string;

  /** Get the directory where transcripts are stored */
  getProjectDir(cwd: string): string;

  /** Get the expected file path for a session (if filename is predictable) */
  getExpectedFile(projectDir: string, sessionId: string): string;

  /** Parse a single line from the transcript file */
  parseLine(
    line: string, 
    agentId: number, 
    context: { 
      activeToolNames: Map<string, string>;
      backgroundAgentToolIds: Set<string>;
    }
  ): AgentEvent[] | null;

  /** Check if a result indicates an async/background agent launch */
  isAsyncAgentResult(block: any): boolean;
}
