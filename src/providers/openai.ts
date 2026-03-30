import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { 
  AgentEvent, 
  AIProvider} from './types';

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  readonly name = 'OpenAI Codex';
  readonly terminalPrefix = 'Codex';

  async buildCommand(sessionId: string, options: { bypassPermissions?: boolean }): Promise<string> {
    // Note: Codex might not support --session-id directly in the same way,
    // but we'll use it if available or rely on rollout files.
    return 'codex';
  }

  async getProjectDir(cwd: string): Promise<string> {
    const dirName = cwd.replace(/[^a-zA-Z0-9-]/g, '-');
    const baseDir = path.join(os.homedir(), '.o1', 'sessions', dirName);
    
    try {
      await fs.promises.access(baseDir);
    } catch {
      const sessionsRoot = path.join(os.homedir(), '.o1', 'sessions');
      try {
        const stats = await fs.promises.stat(sessionsRoot);
        if (stats.isDirectory()) {
          const candidates = await fs.promises.readdir(sessionsRoot);
          const lowerDirName = dirName.toLowerCase();
          const match = candidates.find((c) => c.toLowerCase() === lowerDirName);
          if (match) return path.join(sessionsRoot, match);
        }
      } catch { /* ignore scan errors */ }
    }
    return baseDir;
  }

  async getExpectedFile(projectDir: string, sessionId: string): Promise<string> {
    return path.join(projectDir, `${sessionId}.jsonl`);
  }

  parseLine(
    line: string, 
    agentId: number, 
    context: { activeToolNames: Map<string, string>; backgroundAgentToolIds: Set<string> }
  ): AgentEvent[] | null {
    try {
      const record = JSON.parse(line);
      const events: AgentEvent[] = [];

      // OpenAI Codex JSONL format handling
      // Example: {"type": "tool_call", "tool_call_id": "...", "name": "...", "arguments": {...}}
      if (record.type === 'tool_call' || record.role === 'assistant' && record.tool_calls) {
        const calls = record.tool_calls || [record];
        for (const call of calls) {
          const toolId = call.id || call.tool_call_id;
          const toolName = call.name || call.function?.name;
          if (toolId && toolName) {
            events.push({
              type: 'tool_start',
              toolId,
              toolName,
              status: `Using ${toolName}`
            });
          }
        }
      } else if (record.type === 'tool_result' || record.role === 'tool') {
        const toolId = record.tool_call_id || record.id;
        if (toolId) {
          events.push({ type: 'tool_done', toolId });
        }
      } else if (record.type === 'message' && record.role === 'user') {
        events.push({ type: 'turn_start' });
      } else if (record.type === 'session_end' || record.finish_reason) {
        events.push({ type: 'turn_end' });
      }

      return events.length > 0 ? events : null;
    } catch {
      return null;
    }
  }

  isAsyncAgentResult(block: any): boolean {
    return false; // Default to false for now
  }
}
