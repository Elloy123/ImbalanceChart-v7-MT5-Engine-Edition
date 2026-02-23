"""
SpreadWeightEngine — Adaptado para Forex/MT5
Usa o spread real do MT5 + desvio padrão dos retornos
para classificar regime de volatilidade.
No Forex, spread alarga em alta volatilidade — sinal direto.
"""
from collections import deque
import math
from .base import VolumeEngine

class SpreadWeightEngine(VolumeEngine):
    def __init__(self, config=None):
        cfg = config or {}
        self.window = cfg.get('window', 50)
        self.low_vol = cfg.get('low_vol', 0.00005)
        self.high_vol = cfg.get('high_vol', 0.0002)
        self.returns = deque(maxlen=self.window)
        self.spreads = deque(maxlen=self.window)
        self.last_price = None
    
    def analyze(self, tick, context):
        price = tick.get('price', 0)
        spread = tick.get('spread', 0)
        
        self.spreads.append(spread)
        
        if self.last_price and self.last_price > 0:
            ret = (price - self.last_price) / self.last_price
            self.returns.append(ret)
        self.last_price = price
        
        if len(self.returns) < 5:
            return {'signal': 0.0, 'volatility': 0, 'regime': 'warmup', 'avg_spread': spread}
        
        # Volatility = std of returns
        mean = sum(self.returns) / len(self.returns)
        variance = sum((r - mean) ** 2 for r in self.returns) / len(self.returns)
        vol = math.sqrt(variance) if variance > 0 else 0
        
        # Average spread
        avg_spread = sum(self.spreads) / len(self.spreads) if self.spreads else spread
        
        # Regime classification
        if vol < self.low_vol:
            regime = 'low'
            signal = 0.3  # Low vol = absorption signals more reliable
        elif vol > self.high_vol:
            regime = 'high'
            signal = -0.3  # High vol = less reliable
        else:
            regime = 'medium'
            signal = 0.0
        
        return {
            'signal': signal,
            'volatility': round(vol * 10000, 4),  # in basis points
            'regime': regime,
            'avg_spread': round(avg_spread, 6),
        }
    
    def reset(self):
        self.returns.clear()
        self.spreads.clear()
        self.last_price = None
