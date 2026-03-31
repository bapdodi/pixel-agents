#!/usr/bin/env node
const fs = require('fs');

const currentInbox = process.env.PIXEL_AGENTS_INBOX;
if (!currentInbox) {
  console.error('[pixel-agent-spawn] PIXEL_AGENTS_INBOX not set.');
  process.exit(1);
}

const args = process.argv.slice(2);
let role = 'Architect';
let description = '';
let providerId = 'claude';
let capabilities = [];

args.forEach((arg) => {
  if (arg.startsWith('--role=')) role = arg.split('=')[1];
  if (arg.startsWith('--desc=')) description = arg.split('=')[1];
  if (arg.startsWith('--provider=')) providerId = arg.split('=')[1];
  if (arg.startsWith('--caps='))
    capabilities = arg
      .split('=')[1]
      .split(',')
      .map((s) => s.trim());
});

try {
  const spawnMsg = {
    id: `spawn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    type: 'spawn_agent',
    body: JSON.stringify({
      providerId,
      role,
      description,
      capabilities,
    }),
    sentAt: Date.now(),
  };

  fs.appendFileSync(currentInbox, JSON.stringify(spawnMsg) + '\n');
  console.log(`[pixel-agent-spawn] Requested new agent: ${role} (${providerId})`);
} catch (err) {
  console.error(`[pixel-agent-spawn] Failed: ${err.message}`);
  process.exit(1);
}
