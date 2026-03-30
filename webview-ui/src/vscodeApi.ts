import { isBrowserRuntime } from './runtime';

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

export const vscode: { postMessage(msg: any): void } = isBrowserRuntime
  ? {
      postMessage: (msg: any) => {
        console.log('[vscode.postMessage]', msg);
        // Simulate extension behavior for browser testing
        if (msg.type === 'openClaude') {
          setTimeout(() => {
            window.dispatchEvent(
              new MessageEvent('message', {
                data: {
                  type: 'agentCreated',
                  id: Math.floor(Math.random() * 10000),
                  providerId: msg.providerId || 'claude',
                },
              }),
            );
          }, 100);
        }
      },
    }
  : (acquireVsCodeApi() as { postMessage(msg: unknown): void });

