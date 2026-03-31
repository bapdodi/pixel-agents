// ── Coordination Arc Renderer ─────────────────────────────────
// Renders animated bezier arcs between agents for message/delegate/result/broadcast.

export type ArcType = 'message' | 'delegate' | 'result' | 'broadcast' | string;

export interface MessageArc {
  fromCharId: number;
  toCharId: number;
  arcType: ArcType;
  createdAt: number;
}

const ARC_TRAVEL_SEC = 0.8;
const ARC_HOLD_SEC = 0.5;
const ARC_FADE_SEC = 0.4;
const ARC_TOTAL_SEC = ARC_TRAVEL_SEC + ARC_HOLD_SEC + ARC_FADE_SEC;

const ARC_COLOR: Record<string, string> = {
  message: '#a0c4ff',
  delegate: '#ffd6a5',
  result: '#caffbf',
  broadcast: '#d0b3ff',
};

const DEFAULT_ARC_COLOR = '#e0e0e0';

function getArcColor(arcType: ArcType): string {
  return ARC_COLOR[arcType] ?? DEFAULT_ARC_COLOR;
}

/** Remove arcs older than total duration, return survivors */
export function pruneArcs(arcs: MessageArc[]): MessageArc[] {
  const now = Date.now();
  return arcs.filter((arc) => (now - arc.createdAt) / 1000 < ARC_TOTAL_SEC);
}

interface CharPos {
  x: number;
  y: number;
}

export function renderCoordinationArcs(
  ctx: CanvasRenderingContext2D,
  arcs: MessageArc[],
  getCharPos: (id: number) => CharPos | null,
): void {
  if (arcs.length === 0) return;

  const now = Date.now();

  for (const arc of arcs) {
    const from = getCharPos(arc.fromCharId);
    const to = getCharPos(arc.toCharId);
    if (!from || !to) continue;

    const elapsed = (now - arc.createdAt) / 1000;

    let progress: number;
    let alpha: number;

    if (elapsed < ARC_TRAVEL_SEC) {
      progress = elapsed / ARC_TRAVEL_SEC;
      alpha = 1;
    } else if (elapsed < ARC_TRAVEL_SEC + ARC_HOLD_SEC) {
      progress = 1;
      alpha = 1;
    } else if (elapsed < ARC_TOTAL_SEC) {
      progress = 1;
      alpha = 1 - (elapsed - ARC_TRAVEL_SEC - ARC_HOLD_SEC) / ARC_FADE_SEC;
    } else {
      continue; // should have been pruned
    }

    const color = getArcColor(arc.arcType);

    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));

    // Control point: perpendicular arc bowing upward
    const midX = (from.x + to.x) / 2;
    const midY = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const bow = Math.min(dist * 0.4, 60); // max bow 60px
    const cpX = midX - (dy / dist) * bow;
    const cpY = midY + (dx / dist) * bow;

    // Draw partial bezier up to `progress`
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.shadowColor = color;
    ctx.shadowBlur = 4;

    if (progress >= 1) {
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(cpX, cpY, to.x, to.y);
    } else {
      // De Casteljau partial curve
      const {
        x: ex,
        y: ey,
        cp1x,
        cp1y,
      } = _partialQuadratic(from.x, from.y, cpX, cpY, to.x, to.y, progress);
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(cp1x, cp1y, ex, ey);

      // Draw moving dot at tip
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(ex, ey, 3, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.restore();
      continue;
    }
    ctx.stroke();

    // Arrowhead at destination
    _drawArrowhead(ctx, cpX, cpY, to.x, to.y, color, 7);

    ctx.restore();
  }
}

/** Compute partial quadratic bezier endpoint + adjusted control point */
function _partialQuadratic(
  x0: number,
  y0: number,
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  t: number,
): { x: number; y: number; cp1x: number; cp1y: number } {
  // De Casteljau at t
  const m0x = x0 + (cx - x0) * t;
  const m0y = y0 + (cy - y0) * t;
  const m1x = cx + (x1 - cx) * t;
  const m1y = cy + (y1 - cy) * t;
  const ex = m0x + (m1x - m0x) * t;
  const ey = m0y + (m1y - m0y) * t;
  return { x: ex, y: ey, cp1x: m0x, cp1y: m0y };
}

function _drawArrowhead(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  color: string,
  size: number,
): void {
  const angle = Math.atan2(toY - fromY, toX - fromX);
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.translate(toX, toY);
  ctx.rotate(angle);
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size / 2);
  ctx.lineTo(-size, size / 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
