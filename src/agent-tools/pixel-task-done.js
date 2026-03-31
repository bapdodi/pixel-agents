#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const coordDir = process.env.PIXEL_AGENTS_COORD_DIR;
const currentSessionId = process.env.PIXEL_AGENTS_SESSION_ID;

if (!coordDir || !currentSessionId) {
  console.error('[pixel-task-done] Missing environment variables.');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length < 1) {
  console.log('Usage: pixel-task-done [taskId] ["Result message"]');
  process.exit(1);
}

const taskId = args[0];
const result = args[1] || 'Completed';

try {
  const claimedPath = path.join(coordDir, 'tasks', 'claimed', `${taskId}.${currentSessionId}`);
  const donePath = path.join(coordDir, 'tasks', 'done', `${taskId}.json`);

  if (!fs.existsSync(claimedPath)) {
    console.error(`[pixel-task-done] Task ${taskId} not found in your claimed list.`);
    process.exit(1);
  }

  const task = JSON.parse(fs.readFileSync(claimedPath, 'utf-8'));
  task.status = 'completed';
  task.result = result;
  task.updatedAt = Date.now();

  fs.writeFileSync(donePath, JSON.stringify(task, null, 2), 'utf-8');
  fs.unlinkSync(claimedPath);

  console.log(`[pixel-task-done] Task ${taskId} marked as completed.`);
} catch (err) {
  console.error(`[pixel-task-done] Failed: ${err.message}`);
  process.exit(1);
}
