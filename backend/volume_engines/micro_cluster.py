"""
MicroClusterEngine — Adaptado para Forex/MT5 com tick volume ponderado

CONCEITO: Agrupa trades em janelas de 100ms e detecta absorção.
Absorção = preço vai pra um lado mas volume do lado oposto domina.

ADAPTAÇÃO FOREX:
- Volume real → tick count ponderado
- Side real → tick-rule (inferência por bid/ask change)
- Threshold adaptativo baseado na média de ticks por cluster

PONDERAÇÃO DE TICK VOLUME (3 modos):
1. 'equal'  : Cada tick vale 1 (simples contagem)
2. 'price_weighted' : Ticks que movem mais o preço têm peso maior
3. 'spread_weighted': Ticks em spread apertado têm peso maior (mais confiáveis)

O modo é selecionável pelo painel do frontend.
"""
from collections import deque
import time
from .base import VolumeEngine

class MicroClusterEngine(VolumeEngine):
    def __init__(self, config=None):
        cfg = config or {}
        self.window_ms = cfg.get('window_ms', 100)         # Janela de micro-agrupamento
        self.min_trades = cfg.get('min_trades', 2)          # Mínimo de ticks na janela
        self.dominance_ratio = cfg.get('dominance_ratio', 1.5)  # Ratio para absorção
        self.vol_threshold_pct = cfg.get('vol_threshold_pct', 0.5)  # % da média
        self.weight_mode = cfg.get('weight_mode', 'price_weighted')  # Modo de ponderação
        
        self.current_window = []
        self.window_start = 0
        self.cluster_volumes = deque(maxlen=100)
        self.avg_volume = 0
        self.total_absorptions = 0
        self.last_bid = 0
        self.last_ask = 0
        self.last_price = 0
    
    def _calc_tick_weight(self, tick):
        """Calcula peso do tick baseado no modo selecionado."""
        if self.weight_mode == 'equal':
            return 1.0
        
        elif self.weight_mode == 'price_weighted':
            # Peso proporcional ao movimento de preço
            price = tick.get('price', 0)
            if self.last_price > 0 and price > 0:
                move = abs(price - self.last_price) / self.last_price
                # Normalizar: move típico ~0.00001, move forte ~0.0001
                weight = 1.0 + min(move * 100000, 10.0)  # 1.0 a 11.0
                return weight
            return 1.0
        
        elif self.weight_mode == 'spread_weighted':
            # Spread apertado = tick mais confiável = peso maior
            spread = tick.get('spread', 0)
            avg_spread = tick.get('avg_spread', spread) if spread > 0 else spread
            if spread > 0 and avg_spread > 0:
                # Spread menor que média = peso maior
                ratio = avg_spread / spread
                weight = min(ratio, 3.0)  # Cap at 3x
                return max(0.5, weight)
            return 1.0
        
        return 1.0  # fallback
    
    def _infer_side(self, tick):
        """
        Tick-rule para inferir side no MT5.
        Compara bid/ask com tick anterior:
        - ask subiu, bid estável → compra agressiva
        - bid desceu, ask estável → venda agressiva
        - ambos movem → usa direção do mid-price
        """
        bid = tick.get('bid', 0)
        ask = tick.get('ask', 0)
        
        # Se backend já inferiu o side, usar
        provided_side = tick.get('side', '')
        if provided_side in ('buy', 'sell') and provided_side != '':
            return provided_side
        
        if self.last_bid == 0 or self.last_ask == 0:
            self.last_bid = bid
            self.last_ask = ask
            return 'buy'  # default
        
        bid_change = bid - self.last_bid
        ask_change = ask - self.last_ask
        
        self.last_bid = bid
        self.last_ask = ask
        
        # Tick-rule
        if ask_change > 0 and abs(bid_change) < abs(ask_change) * 0.3:
            return 'buy'   # Ask subiu = compra agressiva
        elif bid_change < 0 and abs(ask_change) < abs(bid_change) * 0.3:
            return 'sell'  # Bid desceu = venda agressiva
        elif ask_change > 0 and bid_change > 0:
            return 'buy'   # Ambos subiram = pressão compradora
        elif ask_change < 0 and bid_change < 0:
            return 'sell'  # Ambos desceram = pressão vendedora
        else:
            # Mid-price direction
            mid = (bid + ask) / 2
            last_mid = (self.last_bid + self.last_ask) / 2
            return 'buy' if mid >= last_mid else 'sell'
    
    def _process_window(self):
        """Processa a janela de micro-agrupamento."""
        if len(self.current_window) < self.min_trades:
            return None
        
        buy_vol = 0
        sell_vol = 0
        first_price = self.current_window[0]['price']
        last_price_w = self.current_window[-1]['price']
        
        for t in self.current_window:
            weight = t.get('weight', 1.0)
            if t['side'] == 'buy':
                buy_vol += weight
            else:
                sell_vol += weight
        
        total_vol = buy_vol + sell_vol
        price_change = last_price_w - first_price
        
        # Guardar para média adaptativa
        self.cluster_volumes.append(total_vol)
        self.avg_volume = sum(self.cluster_volumes) / len(self.cluster_volumes)
        
        # Volume suficiente?
        if total_vol < self.avg_volume * self.vol_threshold_pct:
            return None
        
        # Detecção de absorção por divergência
        is_absorption = False
        absorption_type = None
        absorption_strength = 0
        
        if price_change > 0 and sell_vol > buy_vol * self.dominance_ratio:
            # Preço subiu mas sell domina → buy absorption (compradores absorvendo vendas)
            is_absorption = True
            absorption_type = 'buy_absorption'
            absorption_strength = sell_vol / max(buy_vol, 0.1)
        elif price_change < 0 and buy_vol > sell_vol * self.dominance_ratio:
            # Preço desceu mas buy domina → sell absorption (vendedores absorvendo compras)
            is_absorption = True
            absorption_type = 'sell_absorption'
            absorption_strength = buy_vol / max(sell_vol, 0.1)
        
        if is_absorption:
            self.total_absorptions += 1
        
        signal = 0.0
        if is_absorption:
            signal = 0.7 if absorption_type == 'buy_absorption' else -0.7
            signal *= min(absorption_strength / 3.0, 1.0)
        
        return {
            'is_absorption': is_absorption,
            'absorption_type': absorption_type,
            'absorption_strength': round(absorption_strength, 2),
            'buy_volume': round(buy_vol, 1),
            'sell_volume': round(sell_vol, 1),
            'price_change': price_change,
            'trade_count': len(self.current_window),
            'signal': round(signal, 3),
        }
    
    def analyze(self, tick, context):
        ts = tick.get('timestamp', time.time() * 1000)
        
        # Inferir side via tick-rule
        side = self._infer_side(tick)
        
        # Calcular peso do tick
        weight = self._calc_tick_weight(tick)
        self.last_price = tick.get('price', self.last_price)
        
        enriched_tick = {
            'price': tick.get('price', 0),
            'bid': tick.get('bid', 0),
            'ask': tick.get('ask', 0),
            'side': side,
            'weight': weight,
            'timestamp': ts,
        }
        
        # Nova janela?
        if ts - self.window_start > self.window_ms:
            result = self._process_window()
            self.current_window = [enriched_tick]
            self.window_start = ts
            
            if result:
                result['total_absorptions'] = self.total_absorptions
                result['weight_mode'] = self.weight_mode
                return result
        else:
            self.current_window.append(enriched_tick)
        
        return {
            'signal': 0.0,
            'is_absorption': False,
            'absorption_type': None,
            'absorption_strength': 0,
            'total_absorptions': self.total_absorptions,
            'weight_mode': self.weight_mode,
        }
    
    def set_weight_mode(self, mode):
        """Muda o modo de ponderação em runtime (chamado pelo painel)."""
        if mode in ('equal', 'price_weighted', 'spread_weighted'):
            self.weight_mode = mode
    
    def reset(self):
        self.current_window = []
        self.window_start = 0
        self.cluster_volumes.clear()
        self.avg_volume = 0
        self.total_absorptions = 0
        self.last_bid = 0
        self.last_ask = 0
        self.last_price = 0
