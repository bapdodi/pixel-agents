#!/usr/bin/env node
const fs = require('fs');

const registryFile = process.env.PIXEL_AGENTS_REGISTRY;
const currentSessionId = process.env.PIXEL_AGENTS_SESSION_ID;

if (!registryFile) {
  console.error('[pixel-list] PIXEL_AGENTS_REGISTRY not set.');
  process.exit(1);
}

try {
  const registry = JSON.parse(fs.readFileSync(registryFile, 'utf-8'));
  const agents = Object.values(registry.agents);

  console.log('TEAM AGENTS REGISTRY');
  console.log('--------------------------------------------------------------------------------');
  console.log('| SESSION ID                           | ROLE          | STATUS   | PROVIDER    |');
  console.log('--------------------------------------------------------------------------------');

  agents.forEach((agent) => {
    const isSelf = agent.sessionId === currentSessionId ? '*' : ' ';
    const role = (agent.role || 'Unassigned').padEnd(13);
    const status = (agent.status || 'idle').padEnd(8);
    const provider = (agent.providerName || agent.providerId).padEnd(11);
    const sid = agent.sessionId.padEnd(36);
    console.log(`| ${sid}${isSelf} | ${role} | ${status} | ${provider} |`);
  });

  console.log('--------------------------------------------------------------------------------');
  console.log('(*) - You');
} catch (err) {
  console.error(`[pixel-list] Failed: ${err.message}`);
  process.exit(1);
}
