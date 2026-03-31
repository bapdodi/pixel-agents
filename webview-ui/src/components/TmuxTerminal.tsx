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
  onToggleMinimize: (e: React.MouseEvent) => void;
  officeState: OfficeState;
}

const TmuxTerminal: React.FC<TmuxTerminalProps> = ({
  agents,
  selectedAgent,
  agentTerminalRawData,
  onSelectAgent,
  visible,
  isMinimized,
  onToggleMinimize,
  officeState,
}) => {
  const terminalsRef = useRef<Map<number, { term: Terminal; fit: FitAddon }>>(new Map());
  const containerRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const lastProcessedIndexRef = useRef<{ [id: number]: number }>({});
  const selectedAgentRef = useRef<number | null>(selectedAgent);

  // Sync refs for event listeners
  useEffect(() => {
    selectedAgentRef.current = selectedAgent;
  }, [selectedAgent]);

  // Essential CSS Injection
  useEffect(() => {
    if (!document.getElementById('xterm-essential-style')) {
      const style = document.createElement('style');
      style.id = 'xterm-essential-style';
      style.textContent = `
        .xterm {
          cursor: text;
          position: relative;
          user-select: text !important;
          -webkit-user-select: text !important;
          padding: 8px;
          height: 100%;
        }
        .xterm-viewport::-webkit-scrollbar { width: 8px; }
        .xterm-viewport::-webkit-scrollbar-track { background: #1a1a1a; }
        .xterm-viewport::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
        .xterm-viewport::-webkit-scrollbar-thumb:hover { background: #444; }
      `;
      document.head.appendChild(style);
    }
  }, []);

  const createTerminal = (id: number, container: HTMLDivElement) => {
    console.debug(`[TmuxTerminal] Creating terminal for agent ${id}`);
    const term = new Terminal({
      theme: {
        background: '#1a1a1a',
        foreground: '#d1d1d1',
        cursor: '#D97757',
        selectionBackground: 'rgba(217, 119, 87, 0.4)',
      },
      fontFamily: 'ui-monospace, "Cascadia Code", "Fira Code", monospace',
      fontSize: 13,
      lineHeight: 1.1,
      cursorBlink: true,
      allowTransparency: true,
      scrollback: 5000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    term.onData((data) => {
      vscode.postMessage({ type: 'agentTerminalInput', id, input: data });
    });

    setTimeout(() => {
      try {
        fitAddon.fit();
      } catch {
        /* ignore */
      }
    }, 50);

    return { term, fit: fitAddon };
  };

  // Sync terminals with agents list
  useEffect(() => {
    // 1. Remove terminals for agents no longer present
    const agentSet = new Set(agents);
    for (const [id, t] of terminalsRef.current.entries()) {
      if (!agentSet.has(id)) {
        console.debug(`[TmuxTerminal] Disposing terminal for agent ${id}`);
        t.term.dispose();
        terminalsRef.current.delete(id);
        containerRefs.current.delete(id);
        delete lastProcessedIndexRef.current[id];
      }
    }

    // 2. Create terminals for new agents
    agents.forEach((id) => {
      if (!terminalsRef.current.has(id)) {
        const container = containerRefs.current.get(id);
        if (container) {
          terminalsRef.current.set(id, createTerminal(id, container));
        }
      }
    });
  }, [agents]);

  // Handle data updates for ALL terminals in background
  useEffect(() => {
    agents.forEach((id) => {
      const t = terminalsRef.current.get(id);
      if (!t) return;

      const rawData = agentTerminalRawData[id] || [];
      const lastIdx = lastProcessedIndexRef.current[id] || 0;

      if (rawData.length > lastIdx) {
        for (let i = lastIdx; i < rawData.length; i++) {
          try {
            const b64 = rawData[i];
            const binaryString = atob(b64);
            const bytes = new Uint8Array(binaryString.length);
            for (let j = 0; j < binaryString.length; j++) {
              bytes[j] = binaryString.charCodeAt(j);
            }
            t.term.write(bytes);
          } catch {
            // Silently ignore decoding errors
          }
        }
        lastProcessedIndexRef.current[id] = rawData.length;
      }
    });
  }, [agentTerminalRawData, agents]);

  // Handle Resize and Fit
  useEffect(() => {
    const handleResize = () => {
      terminalsRef.current.forEach((t) => {
        try {
          t.fit.fit();
        } catch {
          /* ignore */
        }
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Fit when layout changes or selected agent changes
  useEffect(() => {
    if (!isMinimized && visible && selectedAgent !== null) {
      const timer = setTimeout(() => {
        const t = terminalsRef.current.get(selectedAgent);
        if (t) {
          try {
            t.fit.fit();
            t.term.focus();
          } catch {
            /* ignore */
          }
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isMinimized, visible, selectedAgent]);

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
        transition: 'height 0.25s ease-out',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: isMinimized ? 'none' : '0 8px 32px rgba(0,0,0,0.6)',
      }}
    >
      {/* Header */}
      <div
        className="terminal-header"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 12px',
          fontSize: '11px',
          background: '#242424',
          color: '#D97757',
          borderBottom: '1px solid #333',
          fontWeight: 'bold',
          cursor: 'pointer',
          userSelect: 'none',
        }}
        onClick={(e) => onToggleMinimize(e)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: agents.length > 0 ? '#4caf50' : '#f44336',
              boxShadow: agents.length > 0 ? '0 0 8px #4caf50' : 'none',
            }}
          />
          AGENT TERMINAL: {isMinimized ? 'PAUSED' : 'ACTIVE'}
        </div>
        <div style={{ fontSize: '10px', opacity: 0.7 }}>
          {isMinimized ? 'CLICK TO EXPAND' : 'CLICK TO COLLAPSE'}
        </div>
      </div>

      {/* Terminal Viewport Container */}
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
              if (el) {
                containerRefs.current.set(id, el);
              }
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

      {/* Agent Selector */}
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
            const name =
              providerId === 'claude' ? 'Claude' : providerId === 'gemini' ? 'Gemini' : `AG:${id}`;

            return (
              <div
                key={id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectAgent(id);
                }}
                style={{
                  padding: '4px 10px',
                  background: selectedAgent === id ? '#D97757' : '#222',
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
