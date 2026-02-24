// ====================================================================
// IMBALANCECHART v7 — ENGINE EDITION (Standalone Frontend, split files)
// ====================================================================

// ---------- CONFIG (mutable — changed by Config panel) ----------
let CONFIG = {
  bg: '#0a0e17',
  bgPanel: '#111827',
  bull: '#00e676',
  bear: '#ff1744',
  bullDark: '#004d40',
  bearDark: '#4a0000',
  bullBody: '#00c853',
  bearBody: '#d50000',
  highlight: '#ffd740',
  accent: '#ff6b35',
  grid: '#1a2332',
  gridStrong: '#2a3a4d',
  text: '#8899aa',
  textStrong: '#e2e8f0',
  crosshair: '#546e7a',
  absorptionBuy: '#00e676',
  absorptionSell: '#ff5252',
  clusterGap: 4,
  histogramBullColor: '#00e676',
  histogramBearColor: '#ff1744',
  histogramOpacity: 85,
  wickWarningThreshold: 50,
  pocColor: '#ffd740',
  currentPriceColor: '#00bcd4',
  clusterOpacity: 70,
  clusterBorderWidth: 1.5,
  clusterBorderColor: '#ffffff',
  showClusterBorder: true,
  wickColor: '#556677',
  wickWidth: 1,
  pocLineWidth: 3,
  showPOC: true,
  showCurrentPrice: true,
  showVolumeLabels: true,
  showWickWarning: true,
  showAbsorptionLevels: true,
  showImbalanceLevels: true,
  absorptionMarkerColor: '#ffff00',
  imbalanceMarkerColor: '#ff00ff',
  drawColor: '#ffd740',
  drawOpacity: 80,
  drawLineWidth: 1.5,
};

const WS_URL = 'ws://localhost:8766';
const PRICE_WIDTH = 80;
const STEP_BASE = 0.50;
let HISTOGRAM_RATIO = 0.25;
let HIST_SPLIT = 0.55;

// ---------- STATE ----------
let ws = null;
let isLive = false;
let clusters = [];
let liquidityBreaks = [];
let activeLiquidityLevels = [];
let backendClosedClusters = [];
let threshold = 100;
let priceStep = 0.50;
let viewMode = 'hybrid';
let showEnginePanel = true;
let showCalibration = false;
let lastPrice = 0;
let lastSide = 'buy';
let totalTicks = 0;
let engineState = {};
let dataSource = 'searching';
let currentSymbol = 'XAUUSD';
let weightMode = 'price_weighted';

const SYMBOLS = {
  'XAUUSD':  { label: 'XAU/USD', dig: 2, delta_th: 100, step: 0.50 },
  'USTEC':   { label: 'USTEC',   dig: 2, delta_th: 150, step: 0.50 },
};

let closedClusters = [];
let formingCluster = null;
let formingTicks = [];
let masterTicks = [];

// ---------- MANUAL LB LABELING (training) ----------
let manualLB = {
  prev: null,
  brk: null,
  items: [],
};

let viewState = {
  offsetX: 0,
  offsetY: 0,
  scaleX: 1,
  scaleY: 1,
  isDragging: false,
  lastX: 0,
  lastY: 0,
};

let crosshair = { x: 0, y: 0, visible: false };
let drawTool = 'none';
let drawings = [];
let currentDrawing = null;
let selectedDrawing = null;
let nextDrawId = 1;

let canvas, ctx;
let chartW, chartH, histH, totalH;

// ---------- INITIALIZATION ----------
function init() {
  canvas = document.getElementById('chart');
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  setupCanvasEvents();
  setupControls();
  render();
  toggleLive();
}

function resize() {
  const container = document.getElementById('chartContainer');
  const w = container.clientWidth;
  const h = container.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  totalH = h;
  histH = Math.floor(h * HISTOGRAM_RATIO);
  chartH = h - histH;
  chartW = w - PRICE_WIDTH;
  render();
}

// ---------- BACKEND SYNC ----------
function syncClusterConfigToBackend() {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'set_cluster_config',
      symbol: currentSymbol,
      delta_th: threshold,
      price_step: priceStep,
    }));
  }
}

// ---------- WEBSOCKET ----------
function connectWS() {
  if (ws && ws.readyState <= 1) return;
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    document.getElementById('wsStatus').className = 'status-badge connected';
    document.getElementById('wsStatus').textContent = '⬤ WS CONECTADO';
    ws.send(JSON.stringify({ type: 'switch_symbol', symbol: currentSymbol }));
    syncClusterConfigToBackend();
    ws.send(JSON.stringify({ action: 'get_history', symbol: currentSymbol, hours: 24 }));
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);

      if (msg.type === 'tick') {
        processTick(msg.data);
        return;
      }

      // --- MODO MANUAL: Handlers automáticos comentados ---
      /*
      else if (msg.type === 'clusters_closed') {
        backendClosedClusters = Array.isArray(msg.clusters) ? msg.clusters : [];
        if (window.LBLineManager) {
          window.LBLineManager.monitorLines(backendClosedClusters);
        }
        render();
      }
      else if (msg.type === 'liquidity_breaks') {
        const all = Array.isArray(msg.breaks) ? msg.breaks : [];
        if (window.LBLineManager) {
          window.LBLineManager.buildLinesFromBreaks(all);
          window.LBLineManager.monitorLines(backendClosedClusters);
        }
        render();
      }
      */

      if (msg.type === 'connected') {
        const src = msg.data?.source || 'unknown';
        dataSource = src;
        const badge = document.getElementById('binanceStatus');
        if (src === 'mt5') {
          badge.style.display = 'inline-flex';
          badge.textContent = '⬤ MT5 EXNESS';
          badge.className = 'status-badge connected';
        } else if (src === 'binance') {
          badge.style.display = 'inline-flex';
          badge.textContent = '⬤ BINANCE';
          badge.className = 'status-badge binance';
        } else {
          badge.style.display = 'inline-flex';
          badge.textContent = '⬤ SIMULAÇÃO';
          badge.className = 'status-badge disconnected';
        }
        document.getElementById('sourceLabel').textContent = src.toUpperCase();
        return;
      }

      if (msg.type === 'history') {
        if (msg.ticks && msg.ticks.length > 0) {
          const sym = msg.symbol || currentSymbol;
          const cfg = SYMBOLS[sym];

          if (cfg) {
            currentSymbol = sym;
            threshold = cfg.delta_th;
            priceStep = cfg.step;

            document.getElementById('thresholdSlider').value = threshold;
            document.getElementById('thresholdValue').textContent =
              threshold >= 1000 ? (threshold/1000)+'k' : threshold;

            const mult = Math.max(1, Math.round(priceStep / STEP_BASE));
            priceStep = mult * STEP_BASE;
            document.getElementById('stepSlider').value = mult;
            document.getElementById('stepValue').textContent = '$' + priceStep.toFixed(2);

            const sel = document.getElementById('symbolSelect');
            if (sel) sel.value = sym;
          }

          const histTicks = msg.ticks.map(t => ({
            price: t.price,
            volume: Math.round(t.volume_synthetic || 1),
            side: t.side || 'buy',
            timestamp: t.timestamp || Date.now(),
            is_absorption: false,
            absorption_type: null,
            absorption_strength: 0,
            composite_signal: 0,
            stacking_buy: 0,
            stacking_sell: 0,
          }));

          fullReprocess(histTicks);
          totalTicks = histTicks.length;
          viewState.offsetY = 0;
          viewState.scaleY = 1;
          autoFitView();
          document.getElementById('sourceLabel').textContent = `${msg.count} ticks (${msg.hours||'?'}h)`;
          syncClusterConfigToBackend();
          render();
        } else {
          document.getElementById('sourceLabel').textContent = msg.error || 'Sem histórico';
        }
        return;
      }

      if (msg.type === 'symbol_changed') {
        if (msg.config) document.getElementById('sourceLabel').textContent = msg.symbol;
        return;
      }

      if (msg.type === 'engine_config') {
        syncCalibration(msg.data);
        return;
      }

      if (msg.type === 'engine_config_updated') {
        console.log('⚙️ Engine updated:', msg.engine, msg.params);
        return;
      }
    } catch (err) {}
  };

  ws.onclose = () => {
    document.getElementById('wsStatus').className = 'status-badge disconnected';
    document.getElementById('wsStatus').textContent = '⬤ DESCONECTADO';
    document.getElementById('binanceStatus').style.display = 'none';
    if (isLive) setTimeout(connectWS, 3000);
  };

  ws.onerror = () => ws.close();
}

function disconnectWS() {
  if (ws) { ws.close(); ws = null; }
  document.getElementById('wsStatus').className = 'status-badge disconnected';
  document.getElementById('wsStatus').textContent = '⬤ DESCONECTADO';
  document.getElementById('binanceStatus').style.display = 'none';
}

// ---------- TICK PROCESSING ----------
function processTick(data) {
  const tick = {
    price: data.price,
    volume: Math.round(data.volume_synthetic || 1),
    side: data.side || 'buy',
    timestamp: data.timestamp || Date.now(),
    is_absorption: data.is_absorption || false,
    absorption_type: data.absorption_type || null,
    absorption_strength: data.absorption_strength || 0,
    composite_signal: data.composite_signal || 0,
    stacking_buy: data.stacking_buy || 0,
    stacking_sell: data.stacking_sell || 0,
  };

  lastPrice = tick.price;
  lastSide = tick.side;
  totalTicks++;

  if (data.engines) {
    engineState = data.engines;
    updateEnginePanel();
  }

  masterTicks.push(tick);
  addTickToForming(tick);

  clusters = [...closedClusters];
  if (formingCluster) clusters.push(formingCluster);

  updateUI();
  render();
}

function addTickToForming(tick) {
  const vol = tick.volume;
  const dp = Math.round(tick.price / priceStep) * priceStep;

  if (formingCluster && Math.abs(formingCluster.delta) >= threshold) {
    formingCluster.isClosed = true;
    formingCluster.endTime = tick.timestamp;
    recalcBodyWick(formingCluster);
    closedClusters.push(formingCluster);
    formingCluster = null;
    formingTicks = [];
  }

  if (!formingCluster) {
    const pl = [{price:dp, volumeBuy:tick.side==='buy'?vol:0, volumeSell:tick.side==='sell'?vol:0, volumeTotal:vol}];
    formingCluster = {
      id: closedClusters.length,
      open:dp, high:dp, low:dp, close:dp,
      volumeBuy:tick.side==='buy'?vol:0, volumeSell:tick.side==='sell'?vol:0,
      volumeTotal:vol, volumeBody:vol, volumeWick:0, wickPercent:0,
      delta:tick.side==='buy'?vol:-vol, tickCount:1, startTime:tick.timestamp,
      isClosed:false, poc:dp, priceLevels:pl,
      absorptionCount:tick.is_absorption?1:0, absorptionBuyCount:tick.absorption_type==='buy_absorption'?1:0,
      absorptionSellCount:tick.absorption_type==='sell_absorption'?1:0,
      maxAbsorptionStrength:tick.absorption_strength||0,
      maxStackingBuy:tick.stacking_buy||0, maxStackingSell:tick.stacking_sell||0,
      compositeSignalAvg:tick.composite_signal||0,
      absorptionLevels: tick.is_absorption ? [{price:dp, type:tick.absorption_type, strength:tick.absorption_strength||0}] : [],
      imbalanceLevels: (tick.stacking_buy>0||tick.stacking_sell>0) ? [{price:dp, buy:tick.stacking_buy||0, sell:tick.stacking_sell||0}] : [],
    };
    formingTicks = [tick];
    return;
  }

  const c = formingCluster;
  c.close = dp;
  c.high = Math.max(c.high, dp);
  c.low = Math.min(c.low, dp);
  c.volumeTotal += vol;
  c.tickCount++;
  formingTicks.push(tick);

  if (tick.side === 'buy') { c.volumeBuy += vol; c.delta += vol; }
  else { c.volumeSell += vol; c.delta -= vol; }

  const ex = c.priceLevels.find(l => l.price === dp);
  if (ex) {
    if (tick.side === 'buy') ex.volumeBuy += vol; else ex.volumeSell += vol;
    ex.volumeTotal += vol;
  } else {
    c.priceLevels.push({price:dp, volumeBuy:tick.side==='buy'?vol:0, volumeSell:tick.side==='sell'?vol:0, volumeTotal:vol});
  }

  let maxV=0;
  for (const l of c.priceLevels) {
    if (l.volumeTotal > maxV) { maxV = l.volumeTotal; c.poc = l.price; }
  }

  if (tick.is_absorption) {
    c.absorptionCount++;
    if (tick.absorption_type==='buy_absorption') c.absorptionBuyCount++;
    if (tick.absorption_type==='sell_absorption') c.absorptionSellCount++;
    c.maxAbsorptionStrength = Math.max(c.maxAbsorptionStrength, tick.absorption_strength||0);
    if (!c.absorptionLevels) c.absorptionLevels = [];
    c.absorptionLevels.push({price:dp, type:tick.absorption_type, strength:tick.absorption_strength||0});
  }

  if ((tick.stacking_buy||0) > 0 || (tick.stacking_sell||0) > 0) {
    if (!c.imbalanceLevels) c.imbalanceLevels = [];
    c.imbalanceLevels.push({price:dp, buy:tick.stacking_buy||0, sell:tick.stacking_sell||0});
  }
  c.maxStackingBuy = Math.max(c.maxStackingBuy, tick.stacking_buy||0);
  c.maxStackingSell = Math.max(c.maxStackingSell, tick.stacking_sell||0);

  const n = c.tickCount;
  c.compositeSignalAvg = (c.compositeSignalAvg*(n-1) + (tick.composite_signal||0)) / n;
}

function recalcBodyWick(cluster) {
  const bodyHigh = Math.max(cluster.open, cluster.close);
  const bodyLow = Math.min(cluster.open, cluster.close);
  let bodyVol = 0;
  let wickVol = 0;
  for (const level of cluster.priceLevels) {
    if (level.price >= bodyLow && level.price <= bodyHigh) bodyVol += level.volumeTotal;
    else wickVol += level.volumeTotal;
  }
  cluster.volumeBody = bodyVol;
  cluster.volumeWick = wickVol;
  cluster.wickPercent = cluster.volumeTotal > 0 ? (wickVol / cluster.volumeTotal) * 100 : 0;
}

function fullReprocess(tickArray) {
  closedClusters = [];
  formingCluster = null;
  formingTicks = [];
  masterTicks = [...tickArray];
  for (const tick of tickArray) addTickToForming(tick);
  clusters = [...closedClusters];
  if (formingCluster) clusters.push(formingCluster);
}

function getAllTicks() {
  return masterTicks;
}

/* =================== RENDER =================== */
function render() {
  if (!ctx) return;
  const w = canvas.width / (window.devicePixelRatio || 1);
  const h = canvas.height / (window.devicePixelRatio || 1);

  ctx.fillStyle = CONFIG.bg;
  ctx.fillRect(0, 0, w, h);

  if (clusters.length === 0) {
    ctx.fillStyle = CONFIG.text;
    ctx.font = '14px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText('Aguardando ticks do MT5...', w / 2, h / 2 - 10);
    ctx.font = '11px JetBrains Mono';
    ctx.fillStyle = CONFIG.crosshair;
    ctx.fillText('Clique ▶ LIVE para conectar ao MT5 Exness', w / 2, h / 2 + 12);
    return;
  }

  const clusterWidth = Math.max(8, 40 * viewState.scaleX);

  let priceHigh = -Infinity, priceLow = Infinity;
  for (const c of clusters) {
    priceHigh = Math.max(priceHigh, c.high);
    priceLow = Math.min(priceLow, c.low);
  }
  const range = (priceHigh - priceLow) * viewState.scaleY;
  const center = (priceHigh + priceLow) / 2;
  const pad = range * 0.15;
  const viewHigh = center + range / 2 + pad + viewState.offsetY;
  const viewLow = center - range / 2 - pad + viewState.offsetY;

  const priceToY = (p) => {
    const rr = viewHigh - viewLow;
    if (rr === 0 || !isFinite(rr)) return chartH / 2;
    const y = ((viewHigh - p) / rr) * chartH;
    return isFinite(y) ? y : chartH / 2;
  };
  const yToPriceLocal = (y) => viewHigh - (y / chartH) * (viewHigh - viewLow);
  const clusterToX = (i) => viewState.offsetX + i * (clusterWidth + CONFIG.clusterGap) + clusterWidth / 2;

  let maxVolume = 1;
  for (const c of clusters) maxVolume = Math.max(maxVolume, c.volumeTotal);

  // GRID
  ctx.lineWidth = 0.5;
  const gridLines = 10;
  const gridStep = (viewHigh - viewLow) / gridLines;
  for (let i = 0; i <= gridLines; i++) {
    const y = (chartH / gridLines) * i;
    const price = viewHigh - gridStep * i;

    ctx.strokeStyle = i % 2 === 0 ? CONFIG.gridStrong + '66' : CONFIG.grid + '44';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(chartW, y);
    ctx.stroke();

    ctx.fillStyle = CONFIG.text;
    ctx.font = '9px JetBrains Mono';
    ctx.textAlign = 'left';
    ctx.fillText(price.toFixed(2), chartW + 5, y + 3);
  }

  // Separator
  ctx.strokeStyle = CONFIG.gridStrong;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(chartW, 0);
  ctx.lineTo(chartW, totalH);
  ctx.stroke();

  // Current price line
  if (lastPrice > 0 && lastPrice >= viewLow && lastPrice <= viewHigh) {
    const cpY = priceToY(lastPrice);
    ctx.strokeStyle = CONFIG.currentPriceColor;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([8, 4]);
    ctx.beginPath();
    ctx.moveTo(0, cpY);
    ctx.lineTo(chartW, cpY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = CONFIG.currentPriceColor;
    ctx.fillRect(chartW + 1, cpY - 10, PRICE_WIDTH - 6, 20);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 10px JetBrains Mono';
    ctx.textAlign = 'left';
    ctx.fillText('$' + lastPrice.toFixed(2), chartW + 4, cpY + 4);

    ctx.fillStyle = CONFIG.currentPriceColor;
    ctx.beginPath();
    ctx.moveTo(chartW, cpY);
    ctx.lineTo(chartW - 6, cpY - 5);
    ctx.lineTo(chartW - 6, cpY + 5);
    ctx.closePath();
    ctx.fill();
  }

  // ========== CLUSTERS (MAIN LOOP) ==========
  for (let idx = 0; idx < clusters.length; idx++) {
    const cluster = clusters[idx];
    const centerX = clusterToX(idx);
    const x = centerX - clusterWidth / 2;
    const cw = clusterWidth;

    if (centerX < -cw || centerX > chartW + cw) continue;

    const isBull = cluster.close >= cluster.open;
    const deltaIntensity = Math.min(1, Math.abs(cluster.delta) / (threshold * 0.8));

    const highY = priceToY(cluster.high);
    const lowY = priceToY(cluster.low);

    ctx.strokeStyle = CONFIG.wickColor;
    ctx.lineWidth = CONFIG.wickWidth;
    ctx.beginPath();
    ctx.moveTo(centerX, highY);
    ctx.lineTo(centerX, lowY);
    ctx.stroke();

    let bodyTop = priceToY(Math.max(cluster.open, cluster.close));
    let bodyBottom = priceToY(Math.min(cluster.open, cluster.close));
    if (!isFinite(bodyTop)) bodyTop = chartH / 2 - 5;
    if (!isFinite(bodyBottom)) bodyBottom = chartH / 2 + 5;
    const bodyH = Math.max(3, bodyBottom - bodyTop);

    const baseAlpha = (CONFIG.clusterOpacity / 100) * (0.3 + deltaIntensity * 0.7);
    const alphaHex = Math.round(Math.min(255, baseAlpha * 255)).toString(16).padStart(2, '0');
    const borderAlpha = Math.round(Math.min(255, (0.5 + deltaIntensity * 0.5) * 255)).toString(16).padStart(2, '0');

    if (viewMode === 'clean') {
      ctx.fillStyle = (isBull ? CONFIG.bullBody : CONFIG.bearBody) + alphaHex;
      ctx.fillRect(x, bodyTop, cw, bodyH);
    } else {
      const grad = ctx.createLinearGradient(x, bodyTop, x, bodyTop + bodyH);
      if (isBull) {
        grad.addColorStop(0, CONFIG.bull + alphaHex);
        grad.addColorStop(0.5, CONFIG.bullBody + alphaHex);
        grad.addColorStop(1, CONFIG.bullDark + alphaHex);
      } else {
        grad.addColorStop(0, CONFIG.bearDark + alphaHex);
        grad.addColorStop(0.5, CONFIG.bearBody + alphaHex);
        grad.addColorStop(1, CONFIG.bear + alphaHex);
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x, bodyTop, cw, bodyH);
    }

    if (CONFIG.showClusterBorder && CONFIG.clusterBorderWidth > 0) {
      ctx.strokeStyle = CONFIG.clusterBorderColor + borderAlpha;
      ctx.lineWidth = CONFIG.clusterBorderWidth;
      ctx.strokeRect(x, bodyTop, cw, bodyH);
    }

    if (viewState.scaleX >= 0.9 && bodyH > 14) {
      ctx.fillStyle = '#ffffff' + borderAlpha;
      ctx.font = 'bold 8px JetBrains Mono';
      ctx.textAlign = 'center';
      const deltaText = (cluster.delta >= 0 ? '+' : '') + (Math.abs(cluster.delta) >= 1000 ? (cluster.delta / 1000).toFixed(1) + 'k' : cluster.delta);
      ctx.fillText(deltaText, centerX, bodyTop + bodyH / 2 + 3);
    }

    if (cluster.priceLevels.length > 0) {
      const pocY = priceToY(cluster.poc);

      ctx.strokeStyle = CONFIG.pocColor + '22';
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(x - 6, pocY);
      ctx.lineTo(x + cw + 6, pocY);
      ctx.stroke();

      ctx.strokeStyle = CONFIG.pocColor + '55';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(x - 5, pocY);
      ctx.lineTo(x + cw + 5, pocY);
      ctx.stroke();

      ctx.strokeStyle = CONFIG.pocColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 4, pocY);
      ctx.lineTo(x + cw + 4, pocY);
      ctx.stroke();

      ctx.fillStyle = CONFIG.pocColor;
      ctx.beginPath();
      ctx.moveTo(x - 6, pocY);
      ctx.lineTo(x - 3, pocY - 3);
      ctx.lineTo(x, pocY);
      ctx.lineTo(x - 3, pocY + 3);
      ctx.closePath();
      ctx.fill();

      if (viewState.scaleX >= 1.2) {
        ctx.fillStyle = CONFIG.pocColor;
        ctx.font = 'bold 7px JetBrains Mono';
        ctx.textAlign = 'center';
        ctx.fillText('POC', centerX, pocY - 5);
      }
    }

    if (viewMode !== 'clean' && cluster.priceLevels.length > 0) {
      const maxLevelVol = Math.max(...cluster.priceLevels.map(l => l.volumeTotal));
      const barRatio = viewMode === 'raw' ? 0.9 : 0.65;

      for (const level of cluster.priceLevels) {
        const ly = priceToY(level.price);
        const volRatio = level.volumeTotal / maxLevelVol;
        const barW = volRatio * cw * barRatio;

        const levelAlpha = Math.round(80 + volRatio * 175).toString(16).padStart(2, '0');
        const isBuyDom = level.volumeBuy >= level.volumeSell;
        ctx.fillStyle = (isBuyDom ? CONFIG.histogramBullColor : CONFIG.histogramBearColor) + levelAlpha;
        ctx.fillRect(centerX - barW / 2, ly - 1.5, barW, 3);

        if (volRatio > 0.7) {
          ctx.fillStyle = (isBuyDom ? '#b9f6ca' : '#ffcdd2') + '66';
          ctx.fillRect(centerX - barW / 2, ly - 0.5, barW, 1);
        }

        if (viewMode === 'raw' && viewState.scaleX >= 1.5 && level.volumeTotal > 0) {
          ctx.fillStyle = isBuyDom ? CONFIG.bull + 'cc' : CONFIG.bear + 'cc';
          ctx.font = '6px JetBrains Mono';
          ctx.textAlign = 'center';
          ctx.fillText(level.volumeTotal.toString(), centerX, ly + 6);
        }
      }

      if (CONFIG.showAbsorptionLevels && cluster.absorptionLevels && cluster.absorptionLevels.length > 0) {
        for (const abs of cluster.absorptionLevels) {
          const ay = priceToY(abs.price);
          const dotR = Math.max(2, Math.min(4, viewState.scaleX * 2.5));
          const isBuyAbs = abs.type === 'buy_absorption';
          const dotColor = isBuyAbs ? CONFIG.absorptionBuy : CONFIG.absorptionSell;

          ctx.shadowColor = dotColor;
          ctx.shadowBlur = 6;
          ctx.fillStyle = dotColor;
          ctx.beginPath();
          ctx.arc(x + cw - dotR - 2, ay, dotR, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;

          ctx.fillStyle = '#ffffff';
          ctx.beginPath();
          ctx.arc(x + cw - dotR - 2, ay, dotR * 0.4, 0, Math.PI * 2);
          ctx.fill();

          ctx.strokeStyle = dotColor + '55';
          ctx.lineWidth = 0.5;
          ctx.setLineDash([2, 2]);
          ctx.beginPath();
          ctx.moveTo(x, ay);
          ctx.lineTo(x + cw, ay);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }

      if (CONFIG.showImbalanceLevels && cluster.imbalanceLevels && cluster.imbalanceLevels.length > 0) {
        for (const imb of cluster.imbalanceLevels) {
          const iy = priceToY(imb.price);
          const dotR = Math.max(1.5, Math.min(3, viewState.scaleX * 2));

          ctx.fillStyle = CONFIG.imbalanceMarkerColor;
          ctx.beginPath();
          ctx.moveTo(x + dotR + 1, iy);
          ctx.lineTo(x + dotR + 1 + dotR, iy - dotR);
          ctx.lineTo(x + dotR + 1 + dotR * 2, iy);
          ctx.lineTo(x + dotR + 1 + dotR, iy + dotR);
          ctx.closePath();
          ctx.fill();

          ctx.fillStyle = CONFIG.imbalanceMarkerColor + '44';
          ctx.fillRect(x, iy - 0.5, cw * 0.15, 1);
        }
      }
    }

    if (viewState.scaleX >= 1) {
      ctx.font = '7px JetBrains Mono';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#667788';
      ctx.fillText('W:' + cluster.volumeWick, centerX, lowY + 10);
      ctx.fillStyle = isBull ? CONFIG.bull + 'cc' : CONFIG.bear + 'cc';
      ctx.fillText('B:' + cluster.volumeBody, centerX, highY - 4);
    }

    if (!cluster.isClosed) {
      ctx.strokeStyle = CONFIG.highlight;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.strokeRect(x - 1, bodyTop - 1, cw + 2, bodyH + 2);
      ctx.setLineDash([]);

      ctx.shadowColor = CONFIG.highlight;
      ctx.shadowBlur = 6;
      ctx.strokeStyle = CONFIG.highlight + '44';
      ctx.lineWidth = 1;
      ctx.strokeRect(x - 2, bodyTop - 2, cw + 4, bodyH + 4);
      ctx.shadowBlur = 0;
    }

    if (cluster.wickPercent >= CONFIG.wickWarningThreshold) {
      const warningY = lowY + 16;

      ctx.shadowColor = CONFIG.highlight;
      ctx.shadowBlur = 8;
      ctx.fillStyle = CONFIG.highlight;
      ctx.beginPath();
      ctx.arc(centerX, warningY, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(centerX, warningY, 2, 0, Math.PI * 2);
      ctx.fill();

      if (viewState.scaleX >= 0.8) {
        ctx.fillStyle = CONFIG.highlight;
        ctx.font = 'bold 8px JetBrains Mono';
        ctx.textAlign = 'center';
        ctx.fillText(cluster.wickPercent.toFixed(0) + '%', centerX, warningY + 13);
      }
    }

    if (cluster.absorptionCount > 0) {
      const ms = Math.min(6, Math.max(3, cw * 0.3));

      if (cluster.absorptionBuyCount > cluster.absorptionSellCount) {
        ctx.fillStyle = CONFIG.absorptionBuy;
        ctx.beginPath();
        ctx.moveTo(centerX, lowY + ms * 3);
        ctx.lineTo(centerX - ms, lowY + ms * 3 + ms * 1.5);
        ctx.lineTo(centerX + ms, lowY + ms * 3 + ms * 1.5);
        ctx.closePath();
        ctx.fill();
      } else if (cluster.absorptionSellCount > 0) {
        ctx.fillStyle = CONFIG.absorptionSell;
        ctx.beginPath();
        ctx.moveTo(centerX, highY - ms * 3);
        ctx.lineTo(centerX - ms, highY - ms * 3 - ms * 1.5);
        ctx.lineTo(centerX + ms, highY - ms * 3 - ms * 1.5);
        ctx.closePath();
        ctx.fill();
      }
    }

    if (cluster.maxStackingBuy >= 2 || cluster.maxStackingSell >= 2) {
      const barW2 = Math.max(2, cw * 0.12);
      const bTop = bodyTop;
      const bH = Math.max(4, bodyH);

      if (cluster.maxStackingBuy >= 2) {
        const intensity = Math.min(cluster.maxStackingBuy / 5, 1);
        const alpha = Math.round(intensity * 200 + 55).toString(16).padStart(2, '0');
        ctx.fillStyle = CONFIG.absorptionBuy + alpha;
        ctx.fillRect(x - barW2 - 1, bTop, barW2, bH);
      }
      if (cluster.maxStackingSell >= 2) {
        const intensity = Math.min(cluster.maxStackingSell / 5, 1);
        const alpha = Math.round(intensity * 200 + 55).toString(16).padStart(2, '0');
        ctx.fillStyle = CONFIG.absorptionSell + alpha;
        ctx.fillRect(x + cw + 1, bTop, barW2, bH);
      }
    }

    if (Math.abs(cluster.compositeSignalAvg) > 0.2 && viewState.scaleX >= 0.7) {
      const dotX = x + cw - 3;
      const dotY = highY - 2;
      const dotSize = Math.min(4, 2 + Math.abs(cluster.compositeSignalAvg) * 3);
      ctx.fillStyle = cluster.compositeSignalAvg > 0 ? CONFIG.absorptionBuy + '88' : CONFIG.absorptionSell + '88';
      ctx.beginPath();
      ctx.arc(dotX, dotY, dotSize, 0, Math.PI * 2);
      ctx.fill();
    }
  } // FIM DO LOOP CLUSTERS

  // ========== MANUAL LB SELECTION MARKERS (ÚNICO LUGAR CORRETO) ==========
  const drawSelectionBox = (clusterId, color, label) => {
    if (clusterId == null) return;

    const idx = Number(clusterId);
    if (!isFinite(idx)) return;

    const centerX = clusterToX(idx);
    const x = centerX - clusterWidth / 2;
    const cw = clusterWidth;

    if (centerX < -cw || centerX > chartW + cw) return;

    const c = clusters[idx];
    if (!c || !c.isClosed) return;

    const bodyTop = priceToY(Math.max(c.open, c.close));
    const bodyBottom = priceToY(Math.min(c.open, c.close));
    const bodyH = Math.max(3, bodyBottom - bodyTop);

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x - 3, bodyTop - 3, cw + 6, bodyH + 6);
    ctx.setLineDash([]);

    ctx.fillStyle = color;
    ctx.font = 'bold 10px JetBrains Mono';
    ctx.textAlign = 'center';
    ctx.fillText(label, centerX, Math.max(12, bodyTop - 10));
    ctx.restore();
  };

  drawSelectionBox(manualLB.prev?.id, '#40c4ff', 'PREV');
  drawSelectionBox(manualLB.brk?.id,  '#ff6b35', 'BREAK');

  // ========== VOLUME HISTOGRAM ==========
  if (histH > 0) {
    const histY = chartH;
    const labelH = 14;
    const gap = 4;
    const availH = histH - labelH - gap;
    const bar1H = availH * HIST_SPLIT;
    const bar2H = availH * (1 - HIST_SPLIT);

    const histGrad = ctx.createLinearGradient(0, histY, 0, histY + histH);
    histGrad.addColorStop(0, '#0f1923');
    histGrad.addColorStop(1, '#0a0e17');
    ctx.fillStyle = histGrad;
    ctx.fillRect(0, histY, chartW + PRICE_WIDTH, histH);

    ctx.strokeStyle = crosshair.visible && Math.abs(crosshair.y - histY) < 6 ? '#667788' : '#334455';
    ctx.lineWidth = crosshair.visible && Math.abs(crosshair.y - histY) < 6 ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(0, histY);
    ctx.lineTo(chartW + PRICE_WIDTH, histY);
    ctx.stroke();

    const midY = histY + labelH + bar1H + gap / 2;
    const nearMid = crosshair.visible && Math.abs(crosshair.y - midY) < 5;
    ctx.strokeStyle = nearMid ? '#8899aa' : '#1e2d3d';
    ctx.lineWidth = nearMid ? 2 : 0.5;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(chartW, midY);
    ctx.stroke();

    ctx.font = 'bold 8px JetBrains Mono';
    ctx.textAlign = 'left';
    ctx.fillStyle = CONFIG.highlight;
    ctx.fillText('VOL', 4, histY + 10);
    ctx.fillStyle = '#667788';
    ctx.fillText('BODY/WICK', 4, midY + 10);

    for (let idx = 0; idx < clusters.length; idx++) {
      const cluster = clusters[idx];
      const centerX = clusterToX(idx);
      const x = centerX - clusterWidth / 2;
      if (centerX < -clusterWidth || centerX > chartW + clusterWidth) continue;

      const isBull = cluster.close >= cluster.open;
      const volRatio = cluster.volumeTotal / maxVolume;

      // ===== BAR 1: VOLUME TOTAL =====
      const v1H = volRatio * (bar1H - 4);
      const v1Y = histY + labelH + bar1H - v1H;

      const vGrad = ctx.createLinearGradient(x, v1Y, x, v1Y + v1H);
      if (isBull) {
        vGrad.addColorStop(0, CONFIG.bull);
        vGrad.addColorStop(1, CONFIG.bullDark + 'cc');
      } else {
        vGrad.addColorStop(0, CONFIG.bear);
        vGrad.addColorStop(1, CONFIG.bearDark + 'cc');
      }
      ctx.fillStyle = vGrad;
      ctx.fillRect(x + 0.5, v1Y, clusterWidth - 1, v1H);

      ctx.fillStyle = isBull ? '#b9f6ca55' : '#ffcdd255';
      ctx.fillRect(x + 0.5, v1Y, clusterWidth - 1, Math.min(2, v1H));

      if (volRatio > 0.3 && viewState.scaleX >= 0.8 && v1H > 10) {
        ctx.fillStyle = '#ffffffbb';
        ctx.font = '7px JetBrains Mono';
        ctx.textAlign = 'center';
        const vText = cluster.volumeTotal >= 1000 ? (cluster.volumeTotal / 1000).toFixed(1) + 'k' : '' + cluster.volumeTotal;
        ctx.fillText(vText, centerX, v1Y + v1H / 2 + 3);
      }

      // ===== BAR 2: BODY / WICK =====
      const v2H = volRatio * (bar2H - 4);
      const v2Y = midY + gap / 2;

      if (cluster.volumeTotal > 0) {
        const bodyPct = cluster.volumeBody / cluster.volumeTotal;
        const wickPct = cluster.volumeWick / cluster.volumeTotal;
        const bodyBarH = v2H * bodyPct;
        const wickBarH = v2H * wickPct;
        const baseY2 = v2Y + bar2H - v2H;

        if (wickBarH > 0) {
          const wickColor = cluster.wickPercent >= 50 ? '#ffd740' : '#455a64';
          ctx.fillStyle = wickColor + 'cc';
          ctx.fillRect(x + 0.5, baseY2, clusterWidth - 1, wickBarH);
        }
        if (bodyBarH > 0) {
          ctx.fillStyle = isBull ? '#4caf50cc' : '#e53935cc';
          ctx.fillRect(x + 0.5, baseY2 + wickBarH, clusterWidth - 1, bodyBarH);
        }
      }

      if (cluster.wickPercent >= CONFIG.wickWarningThreshold) {
        ctx.fillStyle = CONFIG.highlight + 'aa';
        ctx.fillRect(x, histY + histH - 3, clusterWidth, 3);
      }
    }
  }
}

// ---------- HELPERS: CLUSTER PICKING ----------
function getClosedClusterIndexFromCanvasX(x) {
  const clusterWidth = Math.max(8, 40 * viewState.scaleX);
  const step = clusterWidth + CONFIG.clusterGap;
  const idx = Math.round((x - viewState.offsetX) / step);
  return idx;
}

function getClosedClusterByCanvasX(x) {
  const idx = getClosedClusterIndexFromCanvasX(x);
  if (idx < 0 || idx >= closedClusters.length) return null;

  const c = closedClusters[idx];
  if (!c || !c.isClosed) return null;

  return { idx, cluster: c };
}

/* =================== CANVAS EVENTS =================== */
function setupCanvasEvents() {
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    crosshair = { x: Math.min(x, chartW), y, visible: true };

    if (viewState.isDragging) {
      if (viewState.dragMode === 'zoom') {
        const dy = e.clientY - viewState.lastY;
        const zoomFactor = 1 + dy * 0.005;
        viewState.scaleY = Math.max(0.1, Math.min(20, viewState.scaleY * zoomFactor));
        viewState.lastY = e.clientY;
      } else if (viewState.dragMode === 'histResize') {
        const newChartH = Math.max(100, Math.min(totalH - 40, y));
        HISTOGRAM_RATIO = Math.max(0.05, Math.min(0.6, 1 - newChartH / totalH));
        histH = Math.floor(totalH * HISTOGRAM_RATIO);
        chartH = totalH - histH;
      } else if (viewState.dragMode === 'histSplitResize') {
        const histY = chartH;
        const labelH = 14;
        const gap = 4;
        const availH = histH - labelH - gap;
        const relativeY = y - histY - labelH;
        HIST_SPLIT = Math.max(0.15, Math.min(0.85, relativeY / availH));
      } else if (viewState.dragMode === 'moveDrawing' && selectedDrawing !== null) {
        const drawing = drawings.find(d => d.id === selectedDrawing);
        if (drawing && drawing.type === 'hline') {
          drawing.p1.y = yToPrice(y);
        }
      } else {
        const dx = e.clientX - viewState.lastX;
        const dy = e.clientY - viewState.lastY;
        viewState.offsetX += dx;
        if (clusters.length > 0) {
          let pH = -Infinity, pL = Infinity;
          for (const c of clusters) { pH = Math.max(pH, c.high); pL = Math.min(pL, c.low); }
          const priceRange = (pH - pL) * viewState.scaleY * 1.3;
          const pricePerPixel = priceRange / chartH;
          viewState.offsetY += dy * pricePerPixel;
        }
        viewState.lastX = e.clientX;
        viewState.lastY = e.clientY;
      }
    }

    if (!viewState.isDragging) {
      const histBorderY = chartH;
      const labelH = 14, gap = 4;
      const availH = histH - labelH - gap;
      const midSepY = chartH + labelH + availH * HIST_SPLIT + gap / 2;

      if (Math.abs(y - histBorderY) < 6 && x < chartW) canvas.style.cursor = 'row-resize';
      else if (y > chartH && Math.abs(y - midSepY) < 5 && x < chartW) canvas.style.cursor = 'row-resize';
      else if (x > chartW) canvas.style.cursor = 'ns-resize';
      else canvas.style.cursor = 'crosshair';
    }
    render();
  });

  canvas.addEventListener('mouseleave', () => {
    crosshair.visible = false;
    viewState.isDragging = false;
    render();
  });

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // ---------- MANUAL LB PICKER (TOPO - PRIORIDADE MÁXIMA) ----------
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      const hit = getClosedClusterByCanvasX(x);
      if (hit) {
        const c = hit.cluster;
        const picked = { id: c.id, poc: c.poc, endTime: c.endTime };

        if (e.shiftKey) {
          manualLB.prev = picked;
          console.log('[LB manual] prev set:', picked);
        } else { // Ctrl ou Cmd
          manualLB.brk = picked;
          console.log('[LB manual] break set:', picked);
        }

        render();
        return; // IMPEDE QUE O CLIQUE VIRE PAN/DRAG
      }
    }

    if (Math.abs(y - chartH) < 6 && x < chartW) {
      viewState.isDragging = true;
      viewState.dragMode = 'histResize';
    } else if (y > chartH && x < chartW) {
      const labelH = 14, gap = 4;
      const availH = histH - labelH - gap;
      const midSepY = chartH + labelH + availH * HIST_SPLIT + gap / 2;
      if (Math.abs(y - midSepY) < 5) {
        viewState.isDragging = true;
        viewState.dragMode = 'histSplitResize';
      }
    } else if (x > chartW) {
      viewState.isDragging = true;
      viewState.lastY = e.clientY;
      viewState.dragMode = 'zoom';
    } else if (drawTool !== 'none') {
      const price = yToPrice(y);
      const clusterIdx = Math.round((x - viewState.offsetX) / (Math.max(8, 40 * viewState.scaleX) + CONFIG.clusterGap));

      if (!currentDrawing) {
        currentDrawing = {
          id: nextDrawId++,
          type: drawTool,
          p1: { x: clusterIdx, y: price },
          p2: null,
          color: CONFIG.drawColor,
        };
        if (drawTool === 'hline' || drawTool === 'vline') {
          drawings.push({ ...currentDrawing });
          currentDrawing = null;
          setDrawTool('none');
        }
      } else {
        currentDrawing.p2 = { x: clusterIdx, y: price };
        drawings.push({ ...currentDrawing });
        currentDrawing = null;
        setDrawTool('none');
      }
      render();
    } else {
      selectedDrawing = null;
      for (const d of drawings) {
        if (d.type === 'hline') {
          const dy = Math.abs(priceToY(d.p1.y) - y);
          if (dy < 6) { selectedDrawing = d.id; break; }
        }
      }
      viewState.isDragging = true;
      viewState.lastX = e.clientX;
      viewState.lastY = e.clientY;
      viewState.dragMode = selectedDrawing ? 'moveDrawing' : 'pan';
    }
  });

  canvas.addEventListener('mouseup', () => {
    viewState.isDragging = false;
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.ctrlKey) {
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      viewState.scaleX = Math.max(0.2, Math.min(15, viewState.scaleX * delta));
    } else if (e.shiftKey) {
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      viewState.scaleY = Math.max(0.1, Math.min(20, viewState.scaleY * delta));
    } else {
      viewState.offsetX += e.deltaY > 0 ? 50 : -50;
    }
    render();
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selectedDrawing !== null && document.activeElement === document.body) {
        e.preventDefault();
        deleteSelectedDrawing();
      }
    }
    if (e.key === 'Escape') {
      setDrawTool('none');
      currentDrawing = null;
      selectedDrawing = null;
      render();
    }
  });
}

function yToPrice(y) {
  if (clusters.length === 0) return 0;
  let pH = -Infinity, pL = Infinity;
  for (const c of clusters) { pH = Math.max(pH, c.high); pL = Math.min(pL, c.low); }
  const range = (pH - pL) * viewState.scaleY;
  const center = (pH + pL) / 2;
  const pad = range * 0.15;
  const vH = center + range / 2 + pad;
  const vL = center - range / 2 - pad;
  const r = vH - vL;
  return r === 0 ? center : vH - (y / chartH) * r;
}

function priceToY(price) {
  if (clusters.length === 0) return chartH / 2;
  let pH = -Infinity, pL = Infinity;
  for (const c of clusters) { pH = Math.max(pH, c.high); pL = Math.min(pL, c.low); }
  const range = (pH - pL) * viewState.scaleY;
  const center = (pH + pL) / 2;
  const pad = range * 0.15;
  const vH = center + range / 2 + pad + viewState.offsetY;
  const vL = center - range / 2 - pad + viewState.offsetY;
  const rr = vH - vL;
  if (rr === 0 || !isFinite(rr)) return chartH / 2;
  return ((vH - price) / rr) * chartH;
}

// ---------- CONTROLS ----------
function setupControls() {
  document.getElementById('symbolSelect').addEventListener('change', (e) => switchSymbol(e.target.value));

  const thSlider = document.getElementById('thresholdSlider');
  const thValue = document.getElementById('thresholdValue');
  thSlider.addEventListener('input', () => {
    threshold = Number(thSlider.value);
    thValue.textContent = threshold >= 1000 ? (threshold / 1000) + 'k' : threshold;
    const allT = getAllTicks();
    if (allT.length > 0) fullReprocess(allT);
    syncClusterConfigToBackend();
    render();
  });

  const stSlider = document.getElementById('stepSlider');
  const stValue = document.getElementById('stepValue');
  stSlider.addEventListener('input', () => {
    const mult = Math.max(1, Number(stSlider.value) || 1);
    priceStep = mult * STEP_BASE;
    stValue.textContent = '$' + priceStep.toFixed(2);
    const allT = getAllTicks();
    if (allT.length > 0) fullReprocess(allT);
    syncClusterConfigToBackend();
    render();
  });

  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
  });

  document.querySelectorAll('[data-hist]').forEach(btn => {
    btn.addEventListener('click', () => loadHistory(Number(btn.dataset.hist)));
  });

  document.getElementById('weightSelect').addEventListener('change', (e) => setWeightMode(e.target.value));
  document.getElementById('engineToggle').addEventListener('click', toggleEnginePanel);
  document.getElementById('calibToggle').addEventListener('click', toggleCalibration);

  document.querySelectorAll('[data-draw]').forEach(btn => {
    btn.addEventListener('click', () => setDrawTool(btn.dataset.draw));
  });

  document.getElementById('clearDrawBtn').addEventListener('click', clearDrawings);
  document.getElementById('liveBtn').addEventListener('click', toggleLive);
  document.getElementById('findClustersBtn').addEventListener('click', findClusters);
  document.getElementById('resetBtn').addEventListener('click', resetChart);
}

function syncCalibration(config) {
  if (!config) return;
  const sync = (id, engine, param, fmt) => {
    const el = document.getElementById(id);
    const valEl = document.getElementById(id + '_val');
    if (el && config[engine] && config[engine][param] !== undefined) {
      el.value = config[engine][param];
      if (valEl && fmt) valEl.textContent = fmt(config[engine][param]);
    }
  };
  sync('calib_mc_window', 'micro_cluster', 'window_ms', v => v + 'ms');
  sync('calib_mc_dom', 'micro_cluster', 'dominance_ratio', v => parseFloat(v).toFixed(1) + 'x');
  sync('calib_id_ratio', 'imbalance_detector', 'imbalance_ratio', v => parseFloat(v).toFixed(1) + 'x');
  sync('calib_id_stack', 'imbalance_detector', 'min_stacking', v => v);
}

function setColor(key, value) {
  CONFIG[key] = value;
  render();
}

function autoFitView() {
  if (clusters.length === 0) return;
  const cw = Math.max(8, 40 * viewState.scaleX);
  const visibleClusters = Math.floor(chartW / (cw + CONFIG.clusterGap));
  const targetIdx = Math.max(0, clusters.length - visibleClusters);
  viewState.offsetX = -(targetIdx * (cw + CONFIG.clusterGap)) + 20;
  viewState.offsetY = 0;
  viewState.scaleY = 1;
}

function findClusters() {
  if (clusters.length === 0) {
    document.getElementById('sourceLabel').textContent = 'Nenhum cluster';
    return;
  }
  viewState.scaleX = 1;
  viewState.scaleY = 1;
  viewState.offsetY = 0;
  autoFitView();
  render();

  const symDig = (SYMBOLS[currentSymbol] || {}).dig || 2;
  document.getElementById('sourceLabel').textContent =
    `${clusters.length} clusters | ${clusters[clusters.length-1].close.toFixed(symDig)}`;
}

function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('[data-mode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });
  render();
}

function setDrawTool(tool) {
  drawTool = tool;
  currentDrawing = null;
  document.querySelectorAll('[data-draw]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.draw === tool);
  });
  canvas.style.cursor = 'crosshair';
}

function clearDrawings() {
  drawings = [];
  selectedDrawing = null;
  currentDrawing = null;
  render();
}

function deleteSelectedDrawing() {
  if (selectedDrawing !== null) {
    drawings = drawings.filter(d => d.id !== selectedDrawing);
    selectedDrawing = null;
    render();
  }
}

function toggleEnginePanel() {
  showEnginePanel = !showEnginePanel;
  document.getElementById('enginePanel').classList.toggle('visible', showEnginePanel);
  document.getElementById('engineToggle').classList.toggle('active', showEnginePanel);
  resize();
}

function toggleLive() {
  isLive = !isLive;
  const btn = document.getElementById('liveBtn');
  if (isLive) {
    btn.textContent = '⏹ PARAR';
    btn.classList.add('stopped');
    connectWS();
  } else {
    btn.textContent = '▶ LIVE';
    btn.classList.remove('stopped');
    disconnectWS();
  }
}

function toggleCalibration() {
  showCalibration = !showCalibration;
  document.getElementById('calibPanel').classList.toggle('visible', showCalibration);
  document.getElementById('calibToggle').classList.toggle('active', showCalibration);
  resize();
}

function calibEngine(engine, param, value) {
  const fmtMap = {
    'window_ms': v => v + 'ms',
    'dominance_ratio': v => parseFloat(v).toFixed(1) + 'x',
    'imbalance_ratio': v => parseFloat(v).toFixed(1) + 'x',
    'min_stacking': v => v,
  };

  const ids = {
    'micro_cluster_window_ms': 'calib_mc_window_val',
    'micro_cluster_dominance_ratio': 'calib_mc_dom_val',
    'imbalance_detector_imbalance_ratio': 'calib_id_ratio_val',
    'imbalance_detector_min_stacking': 'calib_id_stack_val',
  };

  const key = engine + '_' + param;
  const el = document.getElementById(ids[key]);
  if (el && fmtMap[param]) el.textContent = fmtMap[param](value);

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'set_engine_config',
      engine: engine,
      params: { [param]: parseFloat(value) }
    }));
  }
}

function switchSymbol(sym) {
  currentSymbol = sym;

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'switch_symbol', symbol: sym }));
    setTimeout(() => loadHistory(24), 500);
  }

  closedClusters = [];
  formingCluster = null;
  formingTicks = [];
  masterTicks = [];
  clusters = [];
  totalTicks = 0;
  lastPrice = 0;

  const cfg = SYMBOLS[sym] || {};
  if (cfg.delta_th) {
    threshold = cfg.delta_th;
    document.getElementById('thresholdSlider').value = threshold;
    document.getElementById('thresholdValue').textContent = threshold >= 1000 ? (threshold/1000) + 'k' : threshold;
  }

  const mult = Math.max(1, Math.round((cfg.step || STEP_BASE) / STEP_BASE));
  priceStep = mult * STEP_BASE;
  document.getElementById('stepSlider').value = mult;
  document.getElementById('stepValue').textContent = '$' + priceStep.toFixed(2);

  const el = document.getElementById('engineSourceLabel');
  if (el) el.textContent = (cfg.label || sym);

  syncClusterConfigToBackend();
  render();
}

function setWeightMode(mode) {
  weightMode = mode;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ action: 'set_weight_mode', mode: mode }));
  }
}

function loadHistory(hours) {
  if (!ws || ws.readyState !== 1) return;
  document.getElementById('sourceLabel').textContent = 'carregando ' + hours + 'h...';
  ws.send(JSON.stringify({ action: 'get_history', symbol: currentSymbol, hours }));
}

function resetChart() {
  closedClusters = [];
  formingCluster = null;
  formingTicks = [];
  masterTicks = [];
  clusters = [];
  totalTicks = 0;
  viewState.offsetX = 0;
  viewState.offsetY = 0;
  viewState.scaleX = 1;
  viewState.scaleY = 1;
  updateUI();
  render();
}

function updateUI() {
  const priceEl = document.getElementById('priceDisplay');
  const symDig = (SYMBOLS[currentSymbol] || {}).dig || 2;
  priceEl.textContent = lastPrice > 0 ? lastPrice.toFixed(symDig) : '--';
  priceEl.className = 'price-display ' + (lastSide === 'buy' ? 'up' : 'down');

  document.getElementById('tickCounter').textContent = totalTicks.toLocaleString() + ' ticks';
  document.getElementById('clusterCount').textContent = clusters.filter(c => c.isClosed).length;

  const forming = clusters.find(c => !c.isClosed);
  const bar = document.getElementById('formingBar');

  if (forming) {
    bar.classList.add('visible');
    const deltaEl = document.getElementById('formingDelta');
    deltaEl.textContent = (forming.delta >= 0 ? '+' : '') + forming.delta;
    deltaEl.style.color = forming.delta >= 0 ? CONFIG.bull : CONFIG.bear;

    document.getElementById('formingBody').textContent =
      forming.volumeTotal > 0 ? ((forming.volumeBody / forming.volumeTotal) * 100).toFixed(0) + '%' : '0%';
    document.getElementById('formingWick').textContent = forming.wickPercent.toFixed(0) + '%';

    const absEl = document.getElementById('formingAbsorptions');
    if (forming.absorptionCount > 0) {
      absEl.style.display = 'inline';
      absEl.textContent = `🧩 ${forming.absorptionCount} abs (${forming.absorptionBuyCount}B / ${forming.absorptionSellCount}S)`;
    } else {
      absEl.style.display = 'none';
    }

    const stackEl = document.getElementById('formingStacking');
    if (forming.maxStackingBuy >= 2 || forming.maxStackingSell >= 2) {
      stackEl.style.display = 'inline';
      stackEl.style.color = forming.maxStackingBuy > forming.maxStackingSell ? CONFIG.absorptionBuy : CONFIG.absorptionSell;
      stackEl.style.fontWeight = '700';
      stackEl.textContent = `🔥 Stack B${forming.maxStackingBuy}/S${forming.maxStackingSell}`;
    } else {
      stackEl.style.display = 'none';
    }

    const fill = document.getElementById('deltaBarFill');
    const pct = Math.min(100, (Math.abs(forming.delta) / threshold) * 100);
    fill.style.width = pct + '%';
    fill.style.background = forming.delta >= 0 ? CONFIG.bull : CONFIG.bear;
  } else {
    bar.classList.remove('visible');
  }
}

function updateEnginePanel() {
  const e = engineState;

  if (e.tick_velocity) {
    document.getElementById('eng_velocity').textContent = (e.tick_velocity.velocity || 0).toFixed(1) + ' t/s';
    document.getElementById('eng_velocity_base').textContent = (e.tick_velocity.baseline || 0).toFixed(1);
    const burst = document.getElementById('eng_burst');
    burst.style.display = e.tick_velocity.is_burst ? 'inline' : 'none';
  }

  if (e.micro_cluster) {
    const absEl = document.getElementById('eng_absorption');
    if (e.micro_cluster.is_absorption) {
      const isBuy = e.micro_cluster.absorption_type === 'buy_absorption';
      absEl.textContent = isBuy ? '🟢 BUY ABS' : '🔴 SELL ABS';
      absEl.style.color = isBuy ? CONFIG.absorptionBuy : CONFIG.absorptionSell;
    } else {
      absEl.textContent = 'Sem absorção';
      absEl.style.color = CONFIG.text;
    }
    document.getElementById('eng_abs_total').textContent = e.micro_cluster.total_absorptions || 0;
  }

  if (e.atr_normalize) {
    const atr = e.atr_normalize.atr;
    document.getElementById('eng_atr').textContent = atr ? (atr * 100).toFixed(4) : '--';
    const regimeEl = document.getElementById('eng_atr_regime');
    regimeEl.textContent = e.atr_normalize.regime || 'warmup';
    regimeEl.style.color =
      e.atr_normalize.regime === 'expanding' ? CONFIG.absorptionSell :
      e.atr_normalize.regime === 'contracting' ? CONFIG.absorptionBuy : CONFIG.text;
  }

  if (e.imbalance_detector) {
    document.getElementById('eng_stack_buy').textContent = 'Buy: S' + (e.imbalance_detector.stacking_buy || 0);
    document.getElementById('eng_stack_sell').textContent = 'Sell: S' + (e.imbalance_detector.stacking_sell || 0);
    const dom = document.getElementById('eng_dominant');
    if (e.imbalance_detector.dominant_direction) {
      dom.textContent = '→ ' + e.imbalance_detector.dominant_direction.toUpperCase();
      dom.style.color = e.imbalance_detector.dominant_direction === 'buy' ? CONFIG.absorptionBuy : CONFIG.absorptionSell;
    } else {
      dom.textContent = '';
    }
  }

  if (e.spread_weight) {
    document.getElementById('eng_vol').textContent = (e.spread_weight.volatility || 0).toFixed(2) + ' bps';
    const regEl = document.getElementById('eng_vol_regime');
    regEl.textContent = e.spread_weight.regime || '--';
    regEl.style.color =
      e.spread_weight.regime === 'high' ? CONFIG.absorptionSell :
      e.spread_weight.regime === 'low' ? CONFIG.absorptionBuy : CONFIG.text;
  }

  const signal = e.micro_cluster?.signal || 0;
  const sigEl = document.getElementById('eng_signal');
  sigEl.textContent = (signal * 100).toFixed(0) + '%';
  sigEl.style.color = signal > 0.2 ? CONFIG.absorptionBuy : signal < -0.2 ? CONFIG.absorptionSell : CONFIG.text;
  const labEl = document.getElementById('eng_signal_label');
  labEl.textContent = signal > 0 ? 'bullish' : signal < 0 ? 'bearish' : 'neutro';
}

// ---------- HANDLER TECLA L (SALVAR) ----------
window.addEventListener('keydown', (ev) => {
  if (ev.key.toLowerCase() !== 'l') return;
  if (!manualLB.prev || !manualLB.brk) {
    console.log('[LB manual] selecione prev (shift+click) e break (ctrl+click) antes de salvar');
    return;
  }

  const item = {
    symbol: currentSymbol,
    price_step: priceStep,
    delta_th: threshold,
    prev_cluster_id: manualLB.prev.id,
    break_cluster_id: manualLB.brk.id,
    prev_poc: manualLB.prev.poc,
    break_poc: manualLB.brk.poc,
    time_prev: manualLB.prev.endTime,
    time_break: manualLB.brk.endTime,
    note: '',
    created_at: Date.now(),
  };

  manualLB.items.push(item);
  console.log('[LB manual] SAVED', item);

  const blob = new Blob([JSON.stringify(manualLB.items, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `manual_liquidity_breaks_${currentSymbol}.json`;
  a.click();
});

// ---------- START ----------
document.addEventListener('DOMContentLoaded', init);