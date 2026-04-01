#!/usr/bin/env node
import {
  appendToInbox,
  readAgentEntry,
  rebuildRegistry,
  writeAgentEntry,
} from './coordinationPersistence.js';
import { CoordinationMessage } from './types.js';

const SESSION_ID = process.env.PIXEL_AGENTS_SESSION_ID;

if (!SESSION_ID) {
  process.stderr.write('Error: PIXEL_AGENTS_SESSION_ID not set\n');
  process.exit(1);
}

const sessionId: string = SESSION_ID;

process.stdin.setEncoding('utf8');

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk;
  void processBuffer();
});

async function processBuffer(): Promise<void> {
  while (buffer.length > 0) {
    const trimmedStart = buffer.trimStart();
    if (trimmedStart.length !== buffer.length) {
      buffer = trimmedStart;
    }

    if (buffer.length === 0) return;

    if (/^Content-Length:/i.test(buffer)) {
      const parsed = readContentLengthMessage(buffer);
      if (!parsed) return;
      buffer = parsed.rest;
      await handleRequest(parsed.message);
      continue;
    }

    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex === -1) return;

    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (!line) continue;
    await handleRequest(line);
  }
}

function readContentLengthMessage(input: string): { message: string; rest: string } | null {
  const headerEndCrLf = input.indexOf('\r\n\r\n');
  const headerEndLf = input.indexOf('\n\n');
  const headerEnd =
    headerEndCrLf !== -1 && (headerEndLf === -1 || headerEndCrLf < headerEndLf)
      ? headerEndCrLf
      : headerEndLf;

  if (headerEnd === -1) return null;

  const separatorLength = headerEnd === headerEndCrLf ? 4 : 2;
  const headers = input.slice(0, headerEnd);
  const contentLengthMatch = headers.match(/(?:^|\r?\n)Content-Length:\s*(\d+)/i);
  if (!contentLengthMatch) {
    throw new Error('Missing Content-Length header');
  }

  const contentLength = Number.parseInt(contentLengthMatch[1], 10);
  const messageStart = headerEnd + separatorLength;
  const messageEnd = messageStart + contentLength;

  if (input.length < messageEnd) return null;

  return {
    message: input.slice(messageStart, messageEnd),
    rest: input.slice(messageEnd),
  };
}

async function handleRequest(rawRequest: string): Promise<void> {
  try {
    const request = JSON.parse(rawRequest);
    const { method, params, id } = request;
    const isNotification = id === undefined || id === null;

    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'pixel-agents-mcp', version: '1.0.0' },
      });
      return;
    }

    if (method === 'tools/list') {
      sendResponse(id, {
        tools: [
          {
            name: 'pa_list_agents',
            description:
              'List all agents currently registered with Pixel Agents. Use this instead of reading internal coordination files.',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'pa_spawn_agent',
            description:
              'Spawn a new team member in Pixel Agents. Use this tool directly instead of inspecting internal files.',
            inputSchema: {
              type: 'object',
              properties: {
                role: {
                  type: 'string',
                  description: 'Agent role, for example Backend Dev or QA Engineer.',
                },
                provider: {
                  type: 'string',
                  enum: ['claude', 'gemini', 'openai'],
                  description: 'Provider to use for the new agent.',
                },
                description: {
                  type: 'string',
                  description: 'Short description of the agent responsibility.',
                },
              },
              required: ['role'],
            },
          },
          {
            name: 'pa_send_message',
            description:
              'Send a message to another agent by session ID. Resolve the target from pa_list_agents output.',
            inputSchema: {
              type: 'object',
              properties: {
                toSessionId: { type: 'string', description: 'Target agent session ID.' },
                body: { type: 'string', description: 'Message body.' },
              },
              required: ['toSessionId', 'body'],
            },
          },
          {
            name: 'pa_set_role',
            description: 'Update the current agent role and optional description.',
            inputSchema: {
              type: 'object',
              properties: {
                role: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['role'],
            },
          },
        ],
      });
      return;
    }

    if (method === 'tools/call') {
      const result = await handleToolCall(params?.name, params?.arguments ?? {});
      sendResponse(id, result);
      return;
    }

    if (isNotification) {
      return;
    }

    sendResponse(id, {});
  } catch (err: any) {
    process.stderr.write(`Error handling request: ${err.message}\n`);
  }
}

async function handleToolCall(name: string, args: Record<string, any>) {
  try {
    switch (name) {
      case 'pa_list_agents': {
        const registry = await rebuildRegistry();
        return {
          content: [
            { type: 'text', text: JSON.stringify(Object.values(registry.agents), null, 2) },
          ],
        };
      }

      case 'pa_spawn_agent': {
        const spawnMsg: Partial<CoordinationMessage> = {
          type: 'spawn_agent',
          body: JSON.stringify({
            providerId: args.provider || 'gemini',
            role: args.role,
            description: args.description || '',
          }),
          sentAt: Date.now(),
        };
        await appendToInbox(sessionId, spawnMsg as CoordinationMessage);
        return {
          content: [
            { type: 'text', text: `Spawn requested: ${args.role} (${args.provider || 'gemini'})` },
          ],
        };
      }

      case 'pa_send_message': {
        const msg: Partial<CoordinationMessage> = {
          type: 'send_to',
          toSessionId: args.toSessionId,
          body: args.body,
          sentAt: Date.now(),
        };
        await appendToInbox(sessionId, msg as CoordinationMessage);
        return {
          content: [{ type: 'text', text: 'Message sent.' }],
        };
      }

      case 'pa_set_role': {
        const entry = await readAgentEntry(sessionId);
        if (!entry) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Agent registry entry not found.' }],
          };
        }

        entry.role = args.role;
        entry.roleDescription = args.description || '';
        entry.updatedAt = Date.now();
        await writeAgentEntry(entry);

        return {
          content: [{ type: 'text', text: `Role updated to '${args.role}'.` }],
        };
      }

      default:
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        };
    }
  } catch (err: any) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error: ${err.message}` }],
    };
  }
}

function sendResponse(id: unknown, result: unknown): void {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n${payload}`);
}
