"""
TickVelocityEngine — Adaptado para Forex/MT5
Mede taxa de chegada de ticks por segundo.
No MT5, cada tick = uma mudança de preço, então a velocidade
indica atividade do mercado (correlação com volume real).
"""
from collections import deque
import time
from .base import VolumeEngine

class TickVelocityEngine(VolumeEngine):
    def __init__(self, config=None):
        cfg = config or {}
        self.window_sec = cfg.get('window_sec', 1.0)
        self.burst_threshold = cfg.get('burst_threshold', 2.0)  # 2x baseline = burst
        self.baseline_decay = cfg.get('baseline_decay', 0.995)
        self.timestamps = deque(maxlen=500)
        self.baseline = 5.0  # ticks/sec initial estimate
    
    def analyze(self, tick, context):
        now = tick.get('timestamp', time.time() * 1000) / 1000.0
        self.timestamps.append(now)
        
        # Count ticks in window
        cutoff = now - self.window_sec
        recent = sum(1 for t in self.timestamps if t >= cutoff)
        velocity = recent / self.window_sec
        
        # Adaptive baseline
        self.baseline = self.baseline * self.baseline_decay + velocity * (1 - self.baseline_decay)
        
        relative = velocity / max(self.baseline, 0.1)
        is_burst = relative >= self.burst_threshold
        
        signal = min(1.0, max(-1.0, (relative - 1.0) * 0.5)) if is_burst else 0.0
        
        return {
            'signal': signal,
            'velocity': round(velocity, 1),
            'baseline': round(self.baseline, 1),
            'relative': round(relative, 2),
            'is_burst': is_burst,
        }
    
    def reset(self):
        self.timestamps.clear()
        self.baseline = 5.0
