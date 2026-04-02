import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AgentEvent, AIProvider } from './types';

export class GeminiProvider implements AIProvider {
  readonly id = 'gemini';
  readonly name = 'Google Gemini';
  readonly terminalPrefix = 'Gemini';

  async buildCommand(
    _sessionId: string,
    _options: { bypassPermissions?: boolean },
  ): Promise<string> {
    const startupPrompt =
      'You are a Pixel Agents team member. Use the MCP tools pa_list_agents, pa_check_messages, pa_send_message, pa_spawn_agent, and pa_set_role for coordination. Do not inspect internal files like registry.json or layout.json. PIXEL_AGENTS_SESSION_ID is already available in the environment if the tools need caller context. Continue in interactive mode.';
    return `npx gemini -i "${startupPrompt}"`;
  }

  getSessionIdRegex(): RegExp {
    return /Session ID:\s+([a-f0-9-]+)/i;
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
    } catch {
      /* ignore */
    }
    // Better path to folder mapping for Windows/POSIX
    const dirName = cwd
      .replace(/[:\\/]/g, '-')
      .replace(/--+/g, '-')
      .replace(/^-+|-+$/g, '');
    return path.join(os.homedir(), '.gemini', 'projects', dirName);
  }

  async getExpectedFile(projectDir: string, sessionId: string): Promise<string> {
    const specificPath = path.join(projectDir, `${sessionId}.jsonl`);
    try {
      await fs.promises.access(specificPath);
      return specificPath;
    } catch {
      // Fallback: find the latest .jsonl file in the projectDir
      try {
        const files = await fs.promises.readdir(projectDir);
        const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'));
        if (jsonlFiles.length === 0) return specificPath;

        const stats = await Promise.all(
          jsonlFiles.map(async (f) => {
            const filePath = path.join(projectDir, f);
            const stat = await fs.promises.stat(filePath);
            return { name: f, mtime: stat.mtime.getTime() };
          }),
        );

        stats.sort((a, b) => b.mtime - a.mtime);
        return path.join(projectDir, stats[0].name);
      } catch {
        return specificPath;
      }
    }
  }

  parseLine(
    line: string,
    agentId: number,
    context: { activeToolNames: Map<string, string>; backgroundAgentToolIds: Set<string> },
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
          status: `Using ${record.name}`,
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
