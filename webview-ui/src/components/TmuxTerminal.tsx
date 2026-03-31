import React, { useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

import { vscode } from '../vscodeApi.js';

import 'xterm/css/xterm.css';

interface TmuxTerminalProps {
  agents: number[];
  selectedAgent: number | null;
  agentTerminalRawData: { [id: number]: string[] };
  onSelectAgent: (id: number) => void;
  visible: boolean;
  isMinimized: boolean;
  onToggleMinimize: (e: React.MouseEvent) => void;
  officeState: any;
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
  const containerRef = useRef<HTMLDivElement>(null);
  const [isTerminalReady, setIsTerminalReady] = useState(false);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastProcessedIndexRef = useRef<{ [id: number]: number }>({});
  const selectedAgentRef = useRef<number | null>(selectedAgent);

  // Keep ref in sync for event listeners
  useEffect(() => {
    selectedAgentRef.current = selectedAgent;
    if (isTerminalReady && terminalRef.current && !isMinimized && selectedAgent !== null) {
      terminalRef.current.focus();
    }
  }, [selectedAgent, isMinimized, isTerminalReady]);

  // Essential CSS Injection - Fixes interaction, scroll, and layout in Webview
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
        .xterm .xterm-viewport {
          background-color: #1a1a1a;
          overflow-y: auto !important;
          cursor: default;
          position: absolute;
          right: 0; top: 0; bottom: 0; left: 0;
          z-index: 1;
        }
        .xterm .xterm-screen {
          position: relative;
          z-index: 2;
        }
        .xterm .xterm-helpers {
          position: absolute;
          top: 0;
          z-index: 5;
        }
        .xterm .xterm-helper-textarea {
          position: absolute;
          opacity: 0;
          left: -9999px;
          top: 0;
          width: 0; height: 0;
          z-index: -5;
          white-space: nowrap;
          overflow: hidden;
          resize: none;
        }
        .xterm .xterm-rows {
          font-family: inherit;
          line-height: inherit;
          color: #d1d1d1;
        }
        .xterm-cursor {
          pointer-events: none;
        }
        /* Custom scrollbar for xterm */
        .xterm-viewport::-webkit-scrollbar { width: 8px; }
        .xterm-viewport::-webkit-scrollbar-track { background: #1a1a1a; }
        .xterm-viewport::-webkit-scrollbar-thumb { background: #333; border-radius: 4px; }
        .xterm-viewport::-webkit-scrollbar-thumb:hover { background: #444; }
      `;
      document.head.appendChild(style);
    }
  }, []);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    console.debug('[TmuxTerminal] Initializing xterm.js instance...');
    
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
    
    // Open in container
    term.open(containerRef.current);
    
    // Slight delay to ensure DOM is ready before fit
    setTimeout(() => {
      try {
        fitAddon.fit();
        setIsTerminalReady(true);
      } catch (e) {
        console.warn('[TmuxTerminal] Fit failed on start:', e);
      }
    }, 50);

    term.onData((data) => {
      if (selectedAgentRef.current !== null) {
        vscode.postMessage({ type: 'agentTerminalInput', id: selectedAgentRef.current, input: data });
      }
    });

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    const resizeHandler = () => {
      try { fitAddon.fit(); } catch (e) {}
    };
    window.addEventListener('resize', resizeHandler);

    return () => {
      window.removeEventListener('resize', resizeHandler);
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      setIsTerminalReady(false);
    };
  }, []);

  // Handle agent switching and data updates
  useEffect(() => {
    const term = terminalRef.current;
    if (!isTerminalReady || !term || selectedAgent === null) return;

    try {
      const lastIdx = lastProcessedIndexRef.current[selectedAgent] || 0;
      const rawData = agentTerminalRawData[selectedAgent] || [];

      if (rawData.length === 0) {
        if (lastIdx !== 0) {
          term.reset();
          lastProcessedIndexRef.current[selectedAgent] = 0;
        }
        return;
      }

      // If switching agents or starting fresh
      if (lastIdx === 0) {
        term.reset();
        for (const b64 of rawData) {
          try {
            const binaryString = atob(b64);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            term.write(bytes);
          } catch (e) {
             // Silently catch decoding errors
          }
        }
      } 
      // If just appending new data
      else if (rawData.length > lastIdx) {
        for (let i = lastIdx; i < rawData.length; i++) {
          try {
            const b64 = rawData[i];
            const binaryString = atob(b64);
            const bytes = new Uint8Array(binaryString.length);
            for (let j = 0; j < binaryString.length; j++) {
              bytes[j] = binaryString.charCodeAt(j);
            }
            term.write(bytes);
          } catch (e) {}
        }
      }

      lastProcessedIndexRef.current[selectedAgent] = rawData.length;
    } catch (err) {
      console.error(`[TmuxTerminal] Data update error:`, err);
    }
  }, [selectedAgent, agentTerminalRawData, isTerminalReady]);

  // Refit when layout changes
  useEffect(() => {
    if (isTerminalReady && fitAddonRef.current && visible && !isMinimized) {
      const timer = setTimeout(() => {
        fitAddonRef.current?.fit();
        terminalRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isMinimized, visible, isTerminalReady]);

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

      {/* Terminal Viewport */}
      <div
        ref={containerRef}
        className="xterm-container"
        onClick={() => terminalRef.current?.focus()}
        style={{
          flex: 1,
          width: '100%',
          display: isMinimized ? 'none' : 'block',
          position: 'relative',
        }}
      />

      {/* Agent Selector */}
      {!isMinimized && (
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
            const name = providerId === 'claude' ? 'Claude' : (providerId === 'gemini' ? 'Gemini' : `AG:${id}`);
            
            return (
              <div
                key={id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectAgent(id);
                  if (terminalRef.current) {
                    lastProcessedIndexRef.current[id] = 0;
                  }
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
