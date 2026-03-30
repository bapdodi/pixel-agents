import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { 
  AgentEvent, 
  AIProvider} from './types';

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini';
  readonly name = 'Google Gemini';
  readonly terminalPrefix = 'Gemini';

  async buildCommand(sessionId: string, options: { bypassPermissions?: boolean }): Promise<string> {
    return `npx gemini --session-id ${sessionId}`;
  }

  async getProjectDir(cwd: string): Promise<string> {
    const projectsFile = path.join(os.homedir(), '.gemini', 'projects.json');
    try {
      const stats = await fs.promises.stat(projectsFile);
      if (stats.isFile()) {
        const raw = await fs.promises.readFile(projectsFile, 'utf8');
        const data = JSON.parse(raw);
        if (data[cwd]) return data[cwd];
      }
    } catch { /* ignore */ }
    return path.join(os.homedir(), '.gemini', 'projects', cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
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

      // Gemini specific JSONL format handling
      if (record.type === 'tool_call' && record.tool_call_id) {
        events.push({
          type: 'tool_start',
          toolId: record.tool_call_id,
          toolName: record.name,
          status: `Using ${record.name}`
        });
      } else if (record.type === 'tool_result' && record.tool_call_id) {
        events.push({ type: 'tool_done', toolId: record.tool_call_id });
      } else if (record.type === 'user_message') {
        events.push({ type: 'turn_start' });
      } else if (record.type === 'assistant_message_complete') {
        events.push({ type: 'turn_end' });
      }

      return events.length > 0 ? events : null;
    } catch {
      return null;
    }
  }

  isAsyncAgentResult(block: any): boolean {
    return false;
  }
}
