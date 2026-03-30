import React, { useEffect, useRef } from 'react';

interface TerminalLine {
  content: string;
  type: 'thought' | 'shell';
  timestamp: number;
}

interface AgentHudProps {
  agentId: number;
  lines: TerminalLine[];
  position: { x: number; y: number };
  visible: boolean;
}

const AgentHud: React.FC<AgentHudProps> = ({ agentId, lines, position, visible }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [lines]);

  if (!visible || lines.length === 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        left: position.x + 40, // Offset horizontally from character
        top: position.y - 100, // Float slightly above
        width: '240px',
        maxHeight: '150px',
        backgroundColor: 'rgba(10, 20, 40, 0.75)',
        backdropFilter: 'blur(4px)',
        border: '1px solid rgba(0, 255, 255, 0.3)',
        boxShadow: '0 0 15px rgba(0, 255, 255, 0.2), inset 0 0 10px rgba(0, 255, 255, 0.1)',
        borderRadius: '4px',
        padding: '8px',
        zIndex: 100,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        animation: 'hudAppear 0.3s ease-out forwards',
        transformOrigin: 'bottom left',
      }}
    >
      {/* HUD Header */}
      <div style={{ 
        fontSize: '9px', 
        color: 'rgba(0, 255, 255, 0.6)', 
        marginBottom: '6px',
        letterSpacing: '1px',
        textTransform: 'uppercase',
        borderBottom: '1px solid rgba(0, 255, 255, 0.1)',
        paddingBottom: '2px',
        display: 'flex',
        justifyContent: 'space-between'
      }}>
        <span>SYSTEM_LOG::A{agentId}</span>
        <span className="hud-scanning">REC_</span>
      </div>

      {/* Terminal Content */}
      <div 
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          fontSize: '11px',
          lineHeight: '1.4',
          fontFamily: "'Fira Code', 'Courier New', monospace",
          scrollbarWidth: 'none',
          msOverflowStyle: 'none'
        }}
      >
        {lines.slice(-20).map((line, idx) => (
          <div key={`${line.timestamp}-${idx}`} style={{ 
            color: line.type === 'thought' ? '#a0aec0' : '#4fd1c5',
            marginBottom: '4px',
            textShadow: line.type === 'shell' ? '0 0 5px rgba(79, 209, 197, 0.4)' : 'none',
            opacity: idx === lines.length - 1 ? 1 : 0.7,
            animation: 'lineIn 0.2s ease-out'
          }}>
            <span style={{ color: 'rgba(0, 255, 255, 0.4)', marginRight: '4px' }}>
              {line.type === 'thought' ? '>' : '$'}
            </span>
            {line.content}
          </div>
        ))}
      </div>

      <style>{`
        @keyframes hudAppear {
          from { opacity: 0; transform: scale(0.9) translateY(10px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        @keyframes lineIn {
          from { opacity: 0; transform: translateX(-5px); }
          to { opacity: 1; transform: translateX(0); }
        }
        .hud-scanning {
          animation: blink 1.5s infinite;
        }
        @keyframes blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.2; }
        }
        div::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </div>
  );
};

export default AgentHud;
