import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { 
  AIProvider, 
  AgentEvent 
} from './types';

export class OpenAIProvider implements AIProvider {
  readonly id = 'openai';
  readonly name = 'OpenAI Codex';
  readonly terminalPrefix = 'Codex';

  buildCommand(sessionId: string, options: { bypassPermissions?: boolean }): string {
    // Note: Codex might not support --session-id directly in the same way,
    // but we'll use it if available or rely on rollout files.
    return 'codex';
  }

  getProjectDir(cwd: string): string {
    const now = new Date();
    const yyyy = now.getFullYear().toString();
    const mm = (now.getMonth() + 1).toString().padStart(2, '0');
    const dd = now.getDate().toString().padStart(2, '0');
    
    // Codex stores logs in date-based subfolders
    const baseDir = path.join(os.homedir(), '.codex', 'sessions', yyyy, mm, dd);
    
    if (!fs.existsSync(baseDir)) {
      // Fallback to searching the most recent date folder if current day doesn't exist yet
      const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
      try {
        if (fs.existsSync(sessionsRoot)) {
          return sessionsRoot; // The scanner will recurse from here
        }
      } catch { /* ignore */ }
    }
    return baseDir;
  }

  getExpectedFile(projectDir: string, sessionId: string): string {
    // Codex filenames are rollout-*.jsonl, we'll rely on directory scanning
    return ''; 
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
