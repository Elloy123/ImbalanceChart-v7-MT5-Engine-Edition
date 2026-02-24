/**
 * line_manager.js
 * Gerencia ciclo de vida das linhas de liquidity break:
 * - cria ao detectar break (breakingPOC)
 * - remove quando um novo cluster fechado invalida (mesmo nível, sem tolerância)
 */

/** @type {Map<string, Line>} */
const activeLines = new Map();

/**
 * @typedef {Object} Line
 * @property {string} key
 * @property {number} level
 * @property {'UP_BREAK'|'DOWN_BREAK'} breakType
 * @property {number} breakClusterId
 * @property {number} timeOpen
 * @property {boolean} active
 * @property {number|null} timeClose
 * @property {number|null} closedBy
 */

/**
 * Cria linhas a partir de breaks.
 * Dedup por chave: breakType|level|breakClusterId
 * @param {Object[]} breaks
 */
function buildLinesFromBreaks(breaks) {
  for (const b of breaks || []) {
    const level = Number(b.breakingPOC);
    const breakClusterId = Number(b.cluster_id);
    const timeOpen = Number(b.time);

    if (!isFinite(level) || !isFinite(breakClusterId)) continue;

    const breakType =
      b.type === "SELLERS_REPRICED_HIGHER" ? "UP_BREAK" :
      b.type === "BUYERS_REPRICED_LOWER"  ? "DOWN_BREAK" :
      null;

    if (!breakType) continue;

    const key = `${breakType}|${level.toFixed(6)}|${breakClusterId}`;
    if (activeLines.has(key)) continue;

    activeLines.set(key, {
      key,
      level,
      breakType,
      breakClusterId,
      timeOpen: isFinite(timeOpen) ? timeOpen : Date.now(),
      active: true,
      timeClose: null,
      closedBy: null,
    });
  }
}

/**
 * Invalida linhas com base em novos clusters fechados (do backend).
 *
 * Regra (mesmo nível, sem tolerância):
 * - UP_BREAK (SELLERS_REPRICED_HIGHER): invalida quando aparecer cluster SELL com poc <= level
 * - DOWN_BREAK (BUYERS_REPRICED_LOWER): invalida quando aparecer cluster BUY  com poc >= level
 *
 * @param {Object[]} newClusters
 */
function monitorLines(newClusters) {
  for (const cluster of newClusters || []) {
    const poc = Number(cluster.poc);
    const side = cluster.side; // "BUY" | "SELL"
    const clusterId = cluster.id;
    const tsClose = cluster.ts_close;

    if (!isFinite(poc) || (side !== "BUY" && side !== "SELL")) continue;

    for (const line of activeLines.values()) {
      if (!line.active) continue;

      // Só deixa clusters posteriores invalidarem (opcional, mas recomendado)
      if (typeof clusterId === "number" && clusterId <= line.breakClusterId) continue;

      let invalidated = false;

      if (line.breakType === "UP_BREAK" && side === "SELL") {
        if (poc <= line.level) invalidated = true;
      } else if (line.breakType === "DOWN_BREAK" && side === "BUY") {
        if (poc >= line.level) invalidated = true;
      }

      if (invalidated) {
        line.active = false;
        line.timeClose = tsClose ?? null;
        line.closedBy = clusterId ?? null;
      }
    }
  }

  _pruneInactiveLines();
}

function _pruneInactiveLines() {
  for (const [key, line] of activeLines) {
    if (!line.active) activeLines.delete(key);
  }
}

function getActiveLines() {
  return [...activeLines.values()].filter(l => l.active);
}

/**
 * Desenha linhas ativas (até 10 últimas).
 * @param {CanvasRenderingContext2D} ctx
 * @param {Function} priceToY
 * @param {number} canvasWidth
 */
function renderLines(ctx, priceToY, canvasWidth) {
  const lines = getActiveLines()
    .sort((a, b) => a.breakClusterId - b.breakClusterId)
    .slice(-10);

  for (const line of lines) {
    const y = priceToY(line.level);

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.setLineDash([6, 3]);

    if (line.breakType === "UP_BREAK") {
      ctx.strokeStyle = "#FF6B35"; // laranja
    } else {
      ctx.strokeStyle = "#00C853"; // verde
    }

    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvasWidth, y);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "11px monospace";
    ctx.fillText(`LB @ ${line.level.toFixed(2)}`, canvasWidth - 140, y - 4);

    ctx.restore();
  }
}

// expõe no window (uso direto no browser)
window.LBLineManager = {
  buildLinesFromBreaks,
  monitorLines,
  renderLines,
  getActiveLines,
};