import 'xterm/css/xterm.css';

import React, { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

import { OfficeState } from '../office/engine/officeState.js';
import { vscode } from '../vscodeApi.js';

interface TmuxTerminalProps {
  agents: number[];
  selectedAgent: number | null;
  agentTerminalRawData: { [id: number]: string[] };
  onSelectAgent: (id: number) => void;
  visible: boolean;
  isMinimized: boolean;
  officeState: OfficeState;
}

const TmuxTerminal: React.FC<TmuxTerminalProps> = ({
  agents,
  selectedAgent,
  agentTerminalRawData,
  onSelectAgent,
  visible,
  isMinimized,
  officeState,
}) => {
  const terminalsRef = useRef<Map<number, { term: Terminal; fit: FitAddon }>>(new Map());
  const containerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const lastProcessedIndexRef = useRef<{ [id: number]: number }>({});
  const selectedAgentRef = useRef<number | null>(selectedAgent);

  useEffect(() => {
    selectedAgentRef.current = selectedAgent;
  }, [selectedAgent]);

  useEffect(() => {
    if (!document.getElementById('xterm-essential-style')) {
      const style = document.createElement('style');
      style.id = 'xterm-essential-style';
      style.textContent = `
        .xterm {
          cursor: text;
          position: relative;
          padding: 10px;
          height: 100%;
          background-color: #1a1a1a;
        }
        .xterm .xterm-screen {
          user-select: text !important;
          -webkit-user-select: text !important;
        }
        .xterm-viewport::-webkit-scrollbar { width: 8px; }
        .xterm-viewport::-webkit-scrollbar-track { background: #1a1a1a; }
        .xterm-viewport::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
        .xterm-viewport::-webkit-scrollbar-thumb:hover { background: #444; }
      `;
      document.head.appendChild(style);
    }
  }, []);

  const syncPtySize = (id: number, term: Terminal, fit: FitAddon) => {
    try {
      const container = containerRefs.current.get(id);
      if (!container || container.clientWidth === 0) return;

      fit.fit();
      const { cols, rows } = term;
      if (cols > 0 && rows > 0) {
        vscode.postMessage({ type: 'resizeAgentTerminal', id, cols, rows });
      }
    } catch (e) {
      console.debug('[TmuxTerminal] Sync size failed:', e);
    }
  };

  const createTerminal = (id: number, container: HTMLDivElement, providerId?: string) => {
    let cursorColor = '#D97757'; // Default Claude-like
    let selectionColor = 'rgba(217, 119, 87, 0.4)';

    if (providerId === 'gemini') {
      cursorColor = '#4285f4';
      selectionColor = 'rgba(66, 133, 244, 0.4)';
    } else if (providerId === 'openai') {
      cursorColor = '#10a37f';
      selectionColor = 'rgba(16, 163, 127, 0.4)';
    }

    const term = new Terminal({
      theme: {
        background: '#1a1a1a',
        foreground: '#d1d1d1',
        cursor: cursorColor,
        selectionBackground: selectionColor,
      },
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      allowTransparency: true,
      scrollback: 5000,
      convertEol: true,
      windowsMode: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    // Custom key handler for Ctrl+C only (to support copy on selection)
    // Ctrl+V is handled by browser/xterm defaults which then trigger onData
    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown') {
        if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
          if (term.hasSelection()) {
            document.execCommand('copy');
            return false; // Don't send ^C to PTY when copying
          }
        }
      }
      return true;
    });

    term.onData((data) => {
      vscode.postMessage({ type: 'agentTerminalInput', id, input: data });
    });

    setTimeout(() => syncPtySize(id, term, fitAddon), 200);

    return { term, fit: fitAddon };
  };

  useEffect(() => {
    const agentSet = new Set(agents);
    for (const [id, t] of terminalsRef.current.entries()) {
      if (!agentSet.has(id)) {
        t.term.dispose();
        terminalsRef.current.delete(id);
        containerRefs.current.delete(id);
        delete lastProcessedIndexRef.current[id];
      }
    }

    agents.forEach((id) => {
      if (!terminalsRef.current.has(id)) {
        const container = containerRefs.current.get(id);
        if (container) {
          const providerId = officeState.characters.get(id)?.providerId;
          terminalsRef.current.set(id, createTerminal(id, container, providerId));
        }
      }
    });
  }, [agents]);

  useEffect(() => {
    agents.forEach((id) => {
      const t = terminalsRef.current.get(id);
      if (!t) return;

      const rawData = agentTerminalRawData[id] || [];
      const lastIdx = lastProcessedIndexRef.current[id] || 0;

      if (rawData.length > lastIdx) {
        for (let i = lastIdx; i < rawData.length; i++) {
          // Data is now raw string, no need to Base64 decode
          t.term.write(rawData[i]);
        }
        lastProcessedIndexRef.current[id] = rawData.length;
      }
    });
  }, [agentTerminalRawData, agents]);

  useEffect(() => {
    const handleResize = () => {
      terminalsRef.current.forEach((t, id) => {
        if (selectedAgentRef.current === id) {
          syncPtySize(id, t.term, t.fit);
        }
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (!isMinimized && visible && selectedAgent !== null) {
      const delays = [100, 300, 800];
      const timers = delays.map((ms) =>
        setTimeout(() => {
          const t = terminalsRef.current.get(selectedAgent);
          if (t) {
            syncPtySize(selectedAgent, t.term, t.fit);
            t.term.focus();
          }
        }, ms),
      );
      return () => timers.forEach(clearTimeout);
    }
  }, [isMinimized, visible, selectedAgent]);

  useEffect(() => {
    if (isMinimized) return;
    const observers: ResizeObserver[] = [];
    containerRefs.current.forEach((container, id) => {
      const observer = new ResizeObserver(() => {
        const t = terminalsRef.current.get(id);
        if (t && selectedAgentRef.current === id) {
          syncPtySize(id, t.term, t.fit);
        }
      });
      observer.observe(container);
      observers.push(observer);
    });
    return () => observers.forEach((o) => o.disconnect());
  }, [isMinimized, agents.length, selectedAgent]);

  if (!visible) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: isMinimized ? 32 : 300,
        backgroundColor: '#1a1a1a',
        borderBottom: '2px solid #D97757',
        zIndex: 51,
        transition: 'height 0.2s ease-out',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: isMinimized ? 'none' : '0 8px 32px rgba(0,0,0,0.6)',
      }}
    >
      <div
        className="xterm-viewports"
        style={{
          flex: 1,
          width: '100%',
          display: isMinimized ? 'none' : 'block',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {agents.map((id) => (
          <div
            key={id}
            ref={(el) => {
              if (el) containerRefs.current.set(id, el);
            }}
            className="xterm-container"
            style={{
              width: '100%',
              height: '100%',
              display: selectedAgent === id ? 'block' : 'none',
              position: 'absolute',
              inset: 0,
            }}
            onClick={() => {
              const t = terminalsRef.current.get(id);
              if (t) t.term.focus();
            }}
          />
        ))}

        {agents.length === 0 && (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#444',
              fontSize: '12px',
              fontStyle: 'italic',
            }}
          >
            No active agents
          </div>
        )}
      </div>

      {!isMinimized && agents.length > 1 && (
        <div
          style={{
            height: 34,
            background: '#141414',
            display: 'flex',
            alignItems: 'center',
            padding: '0 8px',
            gap: 4,
            borderTop: '1px solid #222',
            overflowX: 'auto',
          }}
        >
          {agents.map((id) => {
            const ch = officeState.characters.get(id);
            const providerId = ch ? ch.providerId : undefined;

            let tabColor = '#D97757'; // Default Claude
            if (providerId === 'gemini') tabColor = '#4285f4';
            else if (providerId === 'openai') tabColor = '#10a37f';

            const name =
              providerId === 'claude'
                ? 'Claude'
                : providerId === 'gemini'
                  ? 'Gemini'
                  : providerId === 'openai'
                    ? 'OpenAI'
                    : `AG:${id}`;

            return (
              <div
                key={id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectAgent(id);
                }}
                style={{
                  padding: '4px 10px',
                  background: selectedAgent === id ? tabColor : '#222',
                  color: selectedAgent === id ? '#000' : '#888',
                  borderRadius: '3px 3px 0 0',
                  cursor: 'pointer',
                  fontSize: '10px',
                  fontWeight: 'bold',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.15s ease',
                  borderBottom: selectedAgent === id ? 'none' : '1px solid #333',
                }}
              >
                {name}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default TmuxTerminal;
