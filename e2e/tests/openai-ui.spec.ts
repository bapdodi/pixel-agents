import { test, expect } from '@playwright/test';
import path from 'path';

import { launchVSCode, waitForWorkbench } from '../helpers/launch';
import { createAgent, getPixelAgentsFrame, openPixelAgentsPanel } from '../helpers/webview';

const REPO_ROOT = path.join(__dirname, '../..');

test('creating an OpenAI Codex agent from the UI does not surface MCP startup errors', async ({}, testInfo) => {
  const session = await launchVSCode(testInfo.title, {
    useRealHome: true,
    workspaceDirOverride: REPO_ROOT,
  });
  const { window } = session;

  test.setTimeout(120_000);

  try {
    await waitForWorkbench(window);
    await openPixelAgentsPanel(window);

    const frame = await getPixelAgentsFrame(window);
    await createAgent(frame, {
      providerName: 'OpenAI Codex',
      folderMode: 'workspace',
      workspaceFolderName: 'pixel-agents',
      role: 'Manager',
      description: 'UI validation',
      capabilities: 'coordination',
    });

    await frame.waitForTimeout(12_000);

    const bodyText = (await frame.locator('body').textContent()) ?? '';

    await testInfo.attach('webview-text', {
      body: bodyText,
      contentType: 'text/plain',
    });

    expect(bodyText).not.toMatch(/MCP startup incomplete|failed to start|initialize response/i);
  } finally {
    const screenshotPath = path.join(
      __dirname,
      '../../test-results/e2e',
      `openai-ui-final-${Date.now()}.png`,
    );
    try {
      await window.screenshot({ path: screenshotPath });
      await testInfo.attach('final-screenshot', {
        path: screenshotPath,
        contentType: 'image/png',
      });
    } catch {
      // screenshot failure is non-fatal
    }

    await session.cleanup();
  }
});
