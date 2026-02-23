"""
MT5 Bridge Server v7 — Engine Edition
Conecta ao MT5 Exness, multi-symbol, com engines de análise integrados.
Serve frontend estático + WebSocket com dados em tempo real + engine metadata.
Endpoint /history para carregar histórico de 1 dia.
"""
import asyncio
import json
import os
import sys
import time
import math
import random
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional, Dict, List
from dataclasses import dataclass, asdict
from http.server import HTTPServer, SimpleHTTPRequestHandler
import threading

# ==========================================
# MT5 DETECTION
# ==========================================
try:
    import MetaTrader5 as mt5
    MT5_AVAILABLE = True
    print("✅ Biblioteca MetaTrader5 disponível")
except ImportError:
    MT5_AVAILABLE = False
    print("❌ MetaTrader5 não instalado. Execute: pip install MetaTrader5")

try:
    import websockets
except ImportError:
    print("❌ websockets não instalado. Execute: pip install websockets")
    sys.exit(1)

from engine_orchestrator import VolumeEngineOrchestrator, SYMBOL_ENGINE_CONFIG

# ==========================================
# LOGGING
# ==========================================
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

# ==========================================
# SYMBOL CONFIG
# ==========================================
SYM_CFG = {
    'BTCUSD':  {'dig': 2, 'base': 97000.0,  'mult': 1.0,     'bv': 5.0,  'delta_th': 200,  'step': 10.0},
    'XAUUSD':  {'dig': 2, 'base': 2900.0,   'mult': 50.0,    'bv': 10.0, 'delta_th': 100,   'step': 0.50},
    'EURUSD':  {'dig': 5, 'base': 1.0450,   'mult': 100000.0,'bv': 5.0,  'delta_th': 50,    'step': 0.0001},
    'GBPUSD':  {'dig': 5, 'base': 1.2550,   'mult': 100000.0,'bv': 5.0,  'delta_th': 60,    'step': 0.0001},
    'USTEC':   {'dig': 2, 'base': 21500.0,  'mult': 2.0,     'bv': 10.0, 'delta_th': 150,   'step': 1.0},
    'US100':   {'dig': 2, 'base': 21500.0,  'mult': 2.0,     'bv': 10.0, 'delta_th': 150,   'step': 1.0},
    'NAS100':  {'dig': 2, 'base': 21500.0,  'mult': 2.0,     'bv': 10.0, 'delta_th': 150,   'step': 1.0},
}

def gcfg(symbol):
    return SYM_CFG.get(symbol.upper(), {'dig': 5, 'base': 1.0, 'mult': 1000.0, 'bv': 5.0, 'delta_th': 500, 'step': 0.0001})

# ==========================================
# MT5 CREDENTIALS — CONFIGURE AQUI
# ==========================================
MT5_CONFIG = {
    "login": 65261682,
    "password": "Fcom4040#",
    "server": "Exness-MT5Real11",
    "timeout": 60000,
}

# ==========================================
# VOLUME CALCULATOR (Tick-rule + weighted tick volume)
# ==========================================
class VolumeCalculator:
    """
    Calcula volume sintético ponderado e infere side por tick-rule.
    3 modos de ponderação:
    - equal: cada tick = 1
    - price_weighted: ticks com mais movimento = mais peso
    - spread_weighted: ticks em spread apertado = mais confiáveis
    """
    def __init__(self):
        self.last_bid = {}
        self.last_ask = {}
        self.last_mid = {}
        self._init = {}
        self.weight_mode = 'price_weighted'
    
    def calc(self, symbol, bid, ask):
        mid = (bid + ask) / 2
        spread = ask - bid
        config = gcfg(symbol)
        
        if symbol not in self._init:
            self.last_bid[symbol] = bid
            self.last_ask[symbol] = ask
            self.last_mid[symbol] = mid
            self._init[symbol] = True
            return mid, 1.0, 0.0, 'buy', spread
        
        price_change = mid - self.last_mid[symbol]
        bid_change = bid - self.last_bid[symbol]
        ask_change = ask - self.last_ask[symbol]
        
        # Tick-rule side inference
        if ask_change > 0 and abs(bid_change) < abs(ask_change) * 0.3:
            side = 'buy'
        elif bid_change < 0 and abs(ask_change) < abs(bid_change) * 0.3:
            side = 'sell'
        elif bid_change > 0 and ask_change > 0:
            side = 'buy'
        elif bid_change < 0 and ask_change < 0:
            side = 'sell'
        else:
            side = 'buy' if price_change >= 0 else 'sell'
        
        # Weighted tick volume
        if self.weight_mode == 'equal':
            vol = 1.0
        elif self.weight_mode == 'price_weighted':
            move = abs(price_change)
            vol = 1.0 + min(move * config['mult'], 10.0)
        elif self.weight_mode == 'spread_weighted':
            avg_spread = abs(mid * 0.00005)  # typical spread estimate
            vol = max(0.5, min(3.0, avg_spread / max(spread, 1e-10)))
        else:
            vol = 1.0
        
        self.last_bid[symbol] = bid
        self.last_ask[symbol] = ask
        self.last_mid[symbol] = mid
        
        return mid, round(vol, 2), price_change, side, spread
    
    def reset(self, symbol=None):
        if symbol:
            for d in (self.last_bid, self.last_ask, self.last_mid, self._init):
                d.pop(symbol, None)
        else:
            for d in (self.last_bid, self.last_ask, self.last_mid, self._init):
                d.clear()

# ==========================================
# MT5 CONNECTOR
# ==========================================
class MT5Connector:
    def __init__(self):
        self.connected = False
        self.tick_count = 0
    
    def init(self):
        if not MT5_AVAILABLE:
            logger.warning("⚠️ MT5 não disponível")
            return False
        
        logger.info("🔌 Conectando ao MT5...")
        
        try:
            if not mt5.initialize(
                login=MT5_CONFIG["login"],
                password=MT5_CONFIG["password"],
                server=MT5_CONFIG["server"],
                timeout=MT5_CONFIG["timeout"],
            ):
                # Try without credentials (MT5 already open)
                if not mt5.initialize():
                    logger.error(f"❌ Falha: {mt5.last_error()}")
                    return False
            
            self.connected = True
            acc = mt5.account_info()
            if acc:
                logger.info("=" * 55)
                logger.info("✅ MT5 CONECTADO!")
                logger.info(f"   Conta: {acc.login} | {acc.server}")
                logger.info(f"   Saldo: {acc.balance:.2f} {acc.currency}")
                logger.info("=" * 55)
            return True
        except Exception as e:
            logger.error(f"❌ Erro: {e}")
            return False
    
    def shutdown(self):
        if self.connected:
            mt5.shutdown()
            self.connected = False
    
    def enable_symbol(self, symbol):
        if not self.connected:
            return False
        try:
            if mt5.symbol_select(symbol, True):
                info = mt5.symbol_info(symbol)
                if info:
                    logger.info(f"   ✅ {symbol}: bid={info.bid} ask={info.ask} spread={info.spread}")
                return True
            else:
                logger.error(f"   ❌ {symbol} não disponível")
                return False
        except:
            return False
    
    def get_tick(self, symbol):
        if not self.connected:
            return None
        try:
            return mt5.symbol_info_tick(symbol)
        except:
            return None
    
    def get_history(self, symbol, hours=24):
        """Carrega histórico de ticks do MT5."""
        if not self.connected:
            return []
        
        if not mt5.symbol_select(symbol, True):
            return []
        
        utc_to = datetime.now(timezone.utc)
        utc_from = utc_to - timedelta(hours=hours)
        
        logger.info(f"[HIST] Carregando {symbol} últimas {hours}h...")
        
        try:
            raw = mt5.copy_ticks_range(symbol, utc_from, utc_to, mt5.COPY_TICKS_ALL)
            if raw is None or len(raw) == 0:
                raw = mt5.copy_ticks_from(symbol, utc_from, 1000000, mt5.COPY_TICKS_ALL)
            
            if raw is None or len(raw) == 0:
                logger.warning(f"[HIST] Sem ticks para {symbol}")
                return []
            
            logger.info(f"[HIST] {len(raw)} ticks brutos")
            
            vc = VolumeCalculator()
            config = gcfg(symbol)
            result = []
            
            for t in raw:
                try:
                    bid = float(t['bid'])
                    ask = float(t['ask'])
                    if bid <= 0 or ask <= 0:
                        continue
                    
                    try:
                        tms = int(t['time_msc'])
                    except:
                        tms = int(t['time']) * 1000
                    
                    mid, vol, pc, side, spread = vc.calc(symbol, bid, ask)
                    result.append({
                        'price': round(mid, config['dig']),
                        'bid': round(bid, config['dig']),
                        'ask': round(ask, config['dig']),
                        'volume_synthetic': round(vol, 2),
                        'side': side,
                        'timestamp': tms,
                        'spread': round(spread, config['dig']),
                    })
                except:
                    continue
            
            logger.info(f"[HIST] ✅ {len(result)} ticks processados")
            return result
        except Exception as e:
            logger.error(f"[HIST] Erro: {e}")
            return []

# ==========================================
# GLOBAL STATE
# ==========================================
connected_clients = set()
mt5_conn = MT5Connector()
vc = VolumeCalculator()
orchestrator = None
current_symbol = "XAUUSD"
active_symbols = ["BTCUSD", "XAUUSD", "EURUSD", "GBPUSD", "USTEC"]
tick_count = 0
weight_mode = 'price_weighted'

DEFAULT_ENGINES = ["tick_velocity", "spread_weight", "micro_cluster", "atr_normalize", "imbalance_detector"]

# ==========================================
# WEBSOCKET SERVER
# ==========================================
async def broadcast(msg):
    if not connected_clients:
        return
    data = json.dumps(msg)
    dead = set()
    for ws in connected_clients:
        try:
            await ws.send(data)
        except:
            dead.add(ws)
    connected_clients.difference_update(dead)

async def handle_client(ws, path=None):
    global current_symbol, orchestrator, weight_mode
    
    connected_clients.add(ws)
    logger.info(f"👤 Cliente conectado ({len(connected_clients)})")
    
    # Send initial state
    await ws.send(json.dumps({
        'type': 'connected',
        'data': {
            'mt5_connected': mt5_conn.connected,
            'source': 'mt5' if mt5_conn.connected else 'simulation',
            'symbol': current_symbol,
            'symbols': active_symbols,
            'weight_mode': weight_mode,
        }
    }))
    
    try:
        async for msg in ws:
            try:
                data = json.loads(msg)
                action = data.get('type') or data.get('action', '')
                
                if action == 'switch_symbol':
                    sym = data.get('symbol', 'XAUUSD').upper()
                    if sym in SYM_CFG:
                        current_symbol = sym
                        vc.reset(sym)
                        if orchestrator:
                            orchestrator.switch_symbol(sym)
                        if mt5_conn.connected:
                            mt5_conn.enable_symbol(sym)
                        await ws.send(json.dumps({
                            'type': 'symbol_changed',
                            'symbol': sym,
                            'config': gcfg(sym),
                        }))
                        logger.info(f"🔄 Símbolo: {sym}")
                
                elif action == 'get_history':
                    sym = data.get('symbol', current_symbol).upper()
                    hours = data.get('hours', 24)
                    ticks = mt5_conn.get_history(sym, hours)
                    await ws.send(json.dumps({
                        'type': 'history',
                        'symbol': sym,
                        'count': len(ticks),
                        'hours': hours,
                        'ticks': ticks,
                    }))
                
                elif action == 'set_weight_mode':
                    mode = data.get('mode', 'price_weighted')
                    if mode in ('equal', 'price_weighted', 'spread_weighted'):
                        weight_mode = mode
                        vc.weight_mode = mode
                        if orchestrator:
                            orchestrator.set_weight_mode(mode)
                        await broadcast({
                            'type': 'weight_mode_changed',
                            'mode': mode,
                        })
                        logger.info(f"⚖️ Weight mode: {mode}")
                
                elif action in ('ping', 'pong'):
                    await ws.send(json.dumps({'type': 'pong'}))
                    
            except json.JSONDecodeError:
                pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        connected_clients.discard(ws)
        logger.info(f"👤 Cliente desconectado ({len(connected_clients)})")

# ==========================================
# MT5 TICK POLLING LOOP
# ==========================================
async def mt5_poll_loop():
    global tick_count, orchestrator
    
    last_times = {s: 0 for s in active_symbols}
    
    while True:
        if not mt5_conn.connected or not connected_clients:
            await asyncio.sleep(0.5)
            continue
        
        try:
            sym = current_symbol
            tick = mt5_conn.get_tick(sym)
            
            if tick and tick.time != last_times.get(sym, 0):
                last_times[sym] = tick.time
                tick_count += 1
                
                if tick.bid > 0 and tick.ask > 0:
                    config = gcfg(sym)
                    mid, vol, pc, side, spread = vc.calc(sym, tick.bid, tick.ask)
                    
                    tick_data = {
                        'symbol': sym,
                        'price': round(mid, config['dig']),
                        'bid': round(tick.bid, config['dig']),
                        'ask': round(tick.ask, config['dig']),
                        'volume_synthetic': round(vol, 2),
                        'side': side,
                        'timestamp': int(time.time() * 1000),
                        'spread': round(spread, config['dig']),
                        'price_change': round(pc, config['dig']),
                    }
                    
                    # Run engines
                    if orchestrator:
                        analysis = orchestrator.analyze_tick(tick_data)
                        tick_data['is_absorption'] = analysis.get('is_absorption', False)
                        tick_data['absorption_type'] = analysis.get('absorption_type')
                        tick_data['absorption_strength'] = analysis.get('absorption_strength', 0)
                        tick_data['composite_signal'] = analysis.get('composite_signal', 0)
                        tick_data['stacking_buy'] = analysis.get('stacking_buy', 0)
                        tick_data['stacking_sell'] = analysis.get('stacking_sell', 0)
                        tick_data['engines'] = analysis.get('engines', {})
                    
                    await broadcast({'type': 'tick', 'data': tick_data})
                    
                    if tick_count % 200 == 0:
                        side_icon = '🟢' if side == 'buy' else '🔴'
                        logger.info(f"{side_icon} #{tick_count} | {sym} {tick.bid:.{config['dig']}f}/{tick.ask:.{config['dig']}f} | vol={vol:.1f} | Δ={side}")
            
            await asyncio.sleep(0.03)  # ~33 polls/sec
            
        except Exception as e:
            logger.error(f"❌ Poll: {e}")
            await asyncio.sleep(1)

# ==========================================
# SIMULATION FALLBACK
# ==========================================
async def simulation_loop():
    global tick_count, orchestrator
    
    prices = {s: c['base'] for s, c in SYM_CFG.items()}
    n = 0
    
    while True:
        if mt5_conn.connected or not connected_clients:
            await asyncio.sleep(1)
            continue
        
        try:
            n += 1
            sym = current_symbol
            config = gcfg(sym)
            bp = prices.get(sym, config['base'])
            
            nf = bp * 0.00005
            bp += math.sin(n / 300) * nf * 0.3 + (random.random() - 0.5) * nf
            prices[sym] = bp
            
            sp = bp * 0.00008
            bid, ask = bp - sp / 2, bp + sp / 2
            mid, vol, pc, side, spread = vc.calc(sym, bid, ask)
            tick_count += 1
            
            tick_data = {
                'symbol': sym,
                'price': round(mid, config['dig']),
                'bid': round(bid, config['dig']),
                'ask': round(ask, config['dig']),
                'volume_synthetic': round(vol, 2),
                'side': side,
                'timestamp': int(time.time() * 1000),
                'spread': round(spread, config['dig']),
                'price_change': round(pc, config['dig']),
            }
            
            if orchestrator:
                analysis = orchestrator.analyze_tick(tick_data)
                tick_data['is_absorption'] = analysis.get('is_absorption', False)
                tick_data['absorption_type'] = analysis.get('absorption_type')
                tick_data['absorption_strength'] = analysis.get('absorption_strength', 0)
                tick_data['composite_signal'] = analysis.get('composite_signal', 0)
                tick_data['stacking_buy'] = analysis.get('stacking_buy', 0)
                tick_data['stacking_sell'] = analysis.get('stacking_sell', 0)
                tick_data['engines'] = analysis.get('engines', {})
            
            await broadcast({'type': 'tick', 'data': tick_data})
            await asyncio.sleep(0.05 + random.random() * 0.15)
            
        except Exception as e:
            logger.error(f"❌ Sim: {e}")
            await asyncio.sleep(1)

# ==========================================
# HTTP SERVER (serves frontend)
# ==========================================
def start_http_server(port=8000):
    base = os.path.dirname(os.path.abspath(__file__))
    
    for candidate in [
        os.path.join(base, "..", "frontend"),
        os.path.join(base, "frontend"),
    ]:
        if os.path.exists(os.path.join(candidate, "index.html")):
            os.chdir(candidate)
            break
    else:
        print("⚠️ Frontend não encontrado! Coloque index.html na pasta frontend/")
        return
    
    class QuietHandler(SimpleHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass
        def end_headers(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            super().end_headers()
    
    httpd = HTTPServer(("localhost", port), QuietHandler)
    print(f"🌐 Frontend: http://localhost:{port}")
    httpd.serve_forever()

# ==========================================
# MAIN
# ==========================================
async def main():
    global orchestrator
    
    print("\n" + "=" * 60)
    print("  🚀 ImbalanceChart v7 — MT5 Engine Edition")
    print("=" * 60)
    
    # Init orchestrator
    orchestrator = VolumeEngineOrchestrator(
        engine_names=DEFAULT_ENGINES,
        symbol=current_symbol,
    )
    print(f"✅ Engines: {', '.join(DEFAULT_ENGINES)}")
    print(f"⚖️ Weight mode: {weight_mode}")
    
    # Connect MT5
    if MT5_AVAILABLE:
        if mt5_conn.init():
            for sym in active_symbols:
                mt5_conn.enable_symbol(sym)
        else:
            print("⚠️ MT5 não conectou — modo simulação ativado")
    else:
        print("⚠️ Sem MT5 — modo simulação ativado")
    
    print(f"📊 Símbolos: {', '.join(active_symbols)}")
    print(f"📈 Ativo inicial: {current_symbol}")
    
    # HTTP server in thread
    http_thread = threading.Thread(target=start_http_server, daemon=True)
    http_thread.start()
    
    # Start WebSocket server
    print(f"📡 WebSocket: ws://localhost:8765")
    print("=" * 60 + "\n")
    
    server = await websockets.serve(handle_client, "localhost", 8765)
    
    # Start background tasks
    mt5_task = asyncio.create_task(mt5_poll_loop())
    sim_task = asyncio.create_task(simulation_loop())
    
    await asyncio.gather(server.wait_closed(), mt5_task, sim_task)

if __name__ == "__main__":
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    asyncio.run(main())