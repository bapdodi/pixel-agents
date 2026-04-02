#!/usr/bin/env node
import {
  checkMessagesEvent,
  listAgentsEvent,
  resolveEventBusSessionId,
  sendMessageEvent,
  sessionIdSchema,
  setRoleEvent,
  spawnAgentEvent,
} from './eventBus.js';

const ENV_SESSION_ID = process.env.PIXEL_AGENTS_SESSION_ID;

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
        serverInfo: { name: 'pixel-agents-mcp', version: '2.0.0' },
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
            name: 'pa_check_messages',
            description: 'Check your inbox for any new or existing messages from other agents.',
            inputSchema: {
              type: 'object',
              properties: { ...sessionIdSchema(false) },
            },
          },
          {
            name: 'pa_spawn_agent',
            description: 'Spawn a new team member in Pixel Agents through the shared event bus.',
            inputSchema: {
              type: 'object',
              properties: {
                ...sessionIdSchema(false),
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
              'Send a message to another agent by session ID through the shared event bus.',
            inputSchema: {
              type: 'object',
              properties: {
                ...sessionIdSchema(false),
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
                ...sessionIdSchema(false),
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

    if (isNotification) return;
    sendResponse(id, {});
  } catch (err: any) {
    process.stderr.write(`Error handling request: ${err.message}\n`);
  }
}

function requireSession(args: Record<string, any>) {
  const sessionId = resolveEventBusSessionId(args, ENV_SESSION_ID);
  if (!sessionId) {
    return {
      error: {
        isError: true,
        content: [
          {
            type: 'text',
            text: 'Missing sessionId. Provide sessionId in tool input or set PIXEL_AGENTS_SESSION_ID.',
          },
        ],
      },
    };
  }

  return { sessionId };
}

async function handleToolCall(name: string, args: Record<string, any>) {
  try {
    switch (name) {
      case 'pa_list_agents':
        return await listAgentsEvent();

      case 'pa_check_messages': {
        const resolved = requireSession(args);
        if ('error' in resolved) return resolved.error;
        return await checkMessagesEvent(resolved.sessionId);
      }

      case 'pa_spawn_agent': {
        const resolved = requireSession(args);
        if ('error' in resolved) return resolved.error;
        return await spawnAgentEvent(resolved.sessionId, args);
      }

      case 'pa_send_message': {
        const resolved = requireSession(args);
        if ('error' in resolved) return resolved.error;
        return await sendMessageEvent(resolved.sessionId, args);
      }

      case 'pa_set_role': {
        const resolved = requireSession(args);
        if ('error' in resolved) return resolved.error;
        return await setRoleEvent(resolved.sessionId, args);
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
  process.stdout.write(payload + '\n');
}
