import 'xterm/css/xterm.css';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';

import type { TerminalLine } from '../hooks/useExtensionMessages.js';
import { vscode } from '../vscodeApi.js';

interface TmuxTerminalProps {
  agents: number[];
  selectedAgent: number | null;
  agentTerminalLines: { [id: number]: TerminalLine[] };
  agentTerminalRawData: { [id: number]: string[] };
  onSelectAgent: (id: number) => void;
  visible: boolean;
  isMinimized: boolean;
  onToggleMinimize: (e: React.MouseEvent) => void;
}

const TmuxTerminal: React.FC<TmuxTerminalProps> = ({
  agents,
  selectedAgent,
  agentTerminalRawData,
  onSelectAgent,
  visible,
  isMinimized,
  onToggleMinimize,
}) => {
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const dataDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalNodeRef = useRef<HTMLDivElement>(null);
  const processedDataIndex = useRef<Record<number, number>>({});
  const [initTick, setInitTick] = useState(0);
  const [lastDataAt, setLastDataAt] = useState(Date.now());
  const [isStale, setIsStale] = useState(false);

  // Monitor data liveness
  useEffect(() => {
    const timer = setInterval(() => {
      if (agents.length > 0 && selectedAgent !== null && !isMinimized) {
        setIsStale(Date.now() - lastDataAt > 5000);
      } else {
        setIsStale(false);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lastDataAt, agents.length, selectedAgent, isMinimized]);

  // SINGLE Initialization of xterm.js
  const terminalRef = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      if (xtermRef.current) return;
      if (isMinimized) return; // Don't init if minimized

      console.log('[Terminal] 🚀 Initializing xterm.js engine (Static Instance)');
      const term = new Terminal({
        cursorBlink: true,
        fontFamily: 'monospace',
        fontSize: 14,
        lineHeight: 1.0,
        letterSpacing: 0,
        fontWeight: 'normal',
        theme: {
          background: '#1a1a1a',
          foreground: '#f0f0f0',
          cursor: '#D97757',
          black: '#1a1a1a',
          red: '#D97757',
          green: '#a9b1d6',
          yellow: '#e0af68',
          blue: '#7aa2f7',
          magenta: '#bb9af7',
          cyan: '#7dcfff',
          white: '#c0caf5',
        },
        allowProposedApi: true,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(node);
      
      dataDisposableRef.current = term.onData((data) => {
        const currentAgent = (window as any).__pixelSelectedAgent;
        if (currentAgent !== null && currentAgent !== undefined) {
          vscode.postMessage({ type: 'agentTerminalInput', id: currentAgent, input: data });
        }
      });

      xtermRef.current = term;
      fitAddonRef.current = fitAddon;
      
      setTimeout(() => {
        try { fitAddon.fit(); } catch(e) {}
      }, 200);

      setInitTick(t => t + 1);
    }
  }, [isMinimized]);

  // Keep track of selectedAgent for the static onData callback
  useEffect(() => {
    (window as any).__pixelSelectedAgent = selectedAgent;
  }, [selectedAgent]);

  // Handle agent switching and replaying (WITHOUT re-init)
  useEffect(() => {
    const term = xtermRef.current;
    if (!term || selectedAgent === null || isMinimized) return;

    console.log(`[Terminal] 🔄 Switching view to Agent ${selectedAgent} (Replay)`);
    term.clear();
    const rawData = agentTerminalRawData[selectedAgent] || [];
    if (rawData.length > 0) {
      setLastDataAt(Date.now());
      for (const b64 of rawData) {
        try {
          const bytes = Uint8Array.from(window.atob(b64), (c) => c.charCodeAt(0));
          term.write(bytes);
        } catch (e) {}
      }
    }
    processedDataIndex.current[selectedAgent] = rawData.length;
    term.focus();
  }, [selectedAgent, isMinimized]);

  // Handle focus automatically
  useEffect(() => {
    if (visible && !isMinimized && xtermRef.current) {
      setTimeout(() => xtermRef.current?.focus(), 150);
    }
  }, [visible, isMinimized, selectedAgent]);

  // Automated Resizing Engine
  useEffect(() => {
    if (isMinimized || !containerRef.current) return;
    const observer = new ResizeObserver(() => {
      if (fitAddonRef.current && xtermRef.current) {
        try { fitAddonRef.current.fit(); } catch(e) {}
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isMinimized, initTick]);

  // Handle Real-time Streaming Data
  useEffect(() => {
    const term = xtermRef.current;
    if (!term || selectedAgent === null || isMinimized) return;

    const rawData = agentTerminalRawData[selectedAgent] || [];
    const lastIndex = processedDataIndex.current[selectedAgent] || 0;

    if (rawData.length > lastIndex) {
      setLastDataAt(Date.now());
      for (let i = lastIndex; i < rawData.length; i++) {
        try {
          const bytes = Uint8Array.from(window.atob(rawData[i]), (c) => c.charCodeAt(0));
          term.write(bytes);
        } catch (err) {}
      }
      processedDataIndex.current[selectedAgent] = rawData.length;
    }
  }, [agentTerminalRawData, selectedAgent, isMinimized]);

  if (!visible) return null;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: isMinimized ? 32 : 280,
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
        background: '#1a1a1a',
        borderBottom: '2px solid #D97757',
        zIndex: 51,
        transition: 'height 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        boxShadow: isMinimized ? 'none' : '0 4px 20px rgba(0,0,0,0.5)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '4px 10px',
          fontSize: '11px',
          background: '#2d2d2d',
          color: '#D97757',
          borderBottom: '1px solid #3d3d3d',
          fontFamily: 'monospace',
          fontWeight: 'bold',
          letterSpacing: '0.5px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: isStale ? '#ff9800' : (agents.length > 0 ? '#4caf50' : '#f44336'),
            boxShadow: isStale ? '0 0 5px #ff9800' : (agents.length > 0 ? '0 0 5px #4caf50' : 'none'),
            transition: 'background 0.3s ease'
          }} />
          {isStale ? '! NO DATA RECEIVED' : 'TERMINAL SYSTEM READY'}
        </div>
        <div style={{ opacity: 0.8 }}>
          {isStale ? 'PTY MAY BE FROZEN' : `ACTIVE AGENTS: ${agents.length} | FOCUS: ${selectedAgent ?? 'NONE'}`}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          position: 'relative',
          display: isMinimized ? 'none' : 'block',
          opacity: isMinimized ? 0 : 1,
          WebkitFontSmoothing: 'subpixel-antialiased',
        }}
      >
        <div
          ref={terminalRef}
          onClick={() => xtermRef.current?.focus()}
          style={{
            position: 'absolute',
            inset: 0,
            padding: '8px',
            cursor: 'text',
          }}
        />
        
        {agents.length === 0 && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#D97757',
            fontFamily: 'monospace',
            fontSize: '14px',
            textAlign: 'center',
            padding: 20
          }}>
            [ WAITING FOR AGENT CONNECTION... ]
          </div>
        )}
      </div>

      <div
        style={{
          height: 32,
          minHeight: 32,
          background: '#242424',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 10px',
          fontSize: '13px',
          borderTop: '1px solid #333',
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {agents.map((id, index) => {
            const isActive = selectedAgent === id;
            return (
              <div
                key={id}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectAgent(id);
                }}
                style={{
                  padding: '0 10px',
                  background: isActive ? '#D97757' : 'transparent',
                  color: isActive ? '#1a1a1a' : '#D97757',
                  borderRadius: 2,
                  cursor: 'pointer',
                  fontWeight: isActive ? 'bold' : 'normal',
                  transition: 'background 0.2s',
                  fontSize: '11px',
                }}
              >
                {index}:{id === selectedAgent ? `${id}*` : id}
              </div>
            );
          })}
        </div>
        
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div 
            style={{ color: '#D97757', cursor: 'pointer', fontSize: '18px', fontWeight: 'bold' }}
            onClick={(e) => {
              e.stopPropagation();
              onToggleMinimize(e);
            }}
            title={isMinimized ? "Expand" : "Minimize"}
          >
            {isMinimized ? '▴' : '▾'}
          </div>
        </div>
      </div>

      <style>{`
        .xterm-viewport::-webkit-scrollbar { width: 6px; }
        .xterm-viewport::-webkit-scrollbar-track { background: #1a1a1a; }
        .xterm-viewport::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        .xterm-viewport::-webkit-scrollbar-thumb:hover { background: #444; }
        /* Prevent fuzzy fonts - use standard subpixel smoothing */
        .xterm-rows {
          image-rendering: auto;
          -webkit-font-smoothing: subpixel-antialiased;
        }
      `}</style>
    </div>
  );
};

export default TmuxTerminal;
