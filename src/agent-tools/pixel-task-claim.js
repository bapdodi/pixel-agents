#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const coordDir = process.env.PIXEL_AGENTS_COORD_DIR;
const currentSessionId = process.env.PIXEL_AGENTS_SESSION_ID;

if (!coordDir || !currentSessionId) {
  console.error('[pixel-task-claim] Missing environment variables.');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 1) {
  console.log('Usage: pixel-task-claim [taskId]');
  process.exit(1);
}

const taskId = args[0];

try {
  const pendingPath = path.join(coordDir, 'tasks', 'pending', `${taskId}.json`);
  const claimedPath = path.join(coordDir, 'tasks', 'claimed', `${taskId}.${currentSessionId}`);

  if (!fs.existsSync(pendingPath)) {
    console.error(`[pixel-task-claim] Task ${taskId} not found or already claimed.`);
    process.exit(1);
  }

  // Atomic rename to claim
  fs.renameSync(pendingPath, claimedPath);

  // Update status inside the file
  const task = JSON.parse(fs.readFileSync(claimedPath, 'utf-8'));
  task.status = 'in_progress';
  task.claimedBy = currentSessionId;
  task.assignedAt = Date.now();
  task.updatedAt = Date.now();
  fs.writeFileSync(claimedPath, JSON.stringify(task, null, 2), 'utf-8');

  console.log(`[pixel-task-claim] Task ${taskId} claimed successfully.`);
} catch (err) {
  console.error(`[pixel-task-claim] Failed: ${err.message}`);
  process.exit(1);
}
