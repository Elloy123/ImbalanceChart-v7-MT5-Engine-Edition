"""
ATRNormalizeEngine — Candles sintéticos com período configurável.
Calcula ATR real (não tick-a-tick) para classificar regime de volatilidade.
"""
from collections import deque
import time
from .base import VolumeEngine

class ATRNormalizeEngine(VolumeEngine):
    def __init__(self, config=None):
        cfg = config or {}
        self.candle_period_sec = cfg.get('candle_period_sec', 5)
        self.atr_periods = cfg.get('atr_periods', 14)
        self.baseline_decay = cfg.get('baseline_decay', 0.995)
        
        # Current candle
        self.candle_start = 0
        self.candle_open = 0
        self.candle_high = -float('inf')
        self.candle_low = float('inf')
        self.candle_close = 0
        self.prev_close = 0
        
        # ATR
        self.tr_values = deque(maxlen=self.atr_periods)
        self.atr = 0
        self.atr_baseline = 0
    
    def analyze(self, tick, context):
        price = tick.get('price', 0)
        ts = tick.get('timestamp', time.time() * 1000) / 1000.0
        
        if price <= 0:
            return {'signal': 0.0, 'atr': 0, 'regime': 'warmup'}
        
        # Init candle
        if self.candle_start == 0:
            self.candle_start = ts
            self.candle_open = price
            self.candle_high = price
            self.candle_low = price
            self.candle_close = price
            self.prev_close = price
            return {'signal': 0.0, 'atr': 0, 'regime': 'warmup'}
        
        # Update current candle
        self.candle_high = max(self.candle_high, price)
        self.candle_low = min(self.candle_low, price)
        self.candle_close = price
        
        # Close candle?
        if ts - self.candle_start >= self.candle_period_sec:
            # True Range
            tr = max(
                self.candle_high - self.candle_low,
                abs(self.candle_high - self.prev_close),
                abs(self.candle_low - self.prev_close)
            )
            self.tr_values.append(tr)
            
            # ATR
            if len(self.tr_values) >= 2:
                self.atr = sum(self.tr_values) / len(self.tr_values)
                self.atr_baseline = self.atr_baseline * self.baseline_decay + self.atr * (1 - self.baseline_decay)
            
            # Reset candle
            self.prev_close = self.candle_close
            self.candle_start = ts
            self.candle_open = price
            self.candle_high = price
            self.candle_low = price
        
        if self.atr == 0 or self.atr_baseline == 0:
            return {'signal': 0.0, 'atr': 0, 'atr_baseline': 0, 'regime': 'warmup', 'tr': 0}
        
        ratio = self.atr / self.atr_baseline if self.atr_baseline > 0 else 1.0
        
        if ratio < 0.7:
            regime = 'contracting'
            signal = -0.3
        elif ratio > 1.5:
            regime = 'expanding'
            signal = 0.3
        else:
            regime = 'normal'
            signal = 0.0
        
        return {
            'signal': signal,
            'atr': round(self.atr, 8),
            'atr_baseline': round(self.atr_baseline, 8),
            'regime': regime,
            'tr': round(self.tr_values[-1] if self.tr_values else 0, 8),
        }
    
    def reset(self):
        self.candle_start = 0
        self.candle_open = 0
        self.candle_high = -float('inf')
        self.candle_low = float('inf')
        self.candle_close = 0
        self.prev_close = 0
        self.tr_values.clear()
        self.atr = 0
        self.atr_baseline = 0
