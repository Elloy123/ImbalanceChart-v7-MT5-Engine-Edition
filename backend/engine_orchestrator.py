"""
Engine Orchestrator v3 — MT5 Edition
Coordena engines com configuração por símbolo e modo de ponderação configurável.
"""
from typing import List, Dict, Any, Optional
from volume_engines import (
    VolumeEngine,
    TickVelocityEngine,
    SpreadWeightEngine,
    MicroClusterEngine,
    ATRNormalizeEngine,
    ImbalanceDetectorEngine,
)

ENGINE_REGISTRY = {
    "tick_velocity": TickVelocityEngine,
    "spread_weight": SpreadWeightEngine,
    "micro_cluster": MicroClusterEngine,
    "atr_normalize": ATRNormalizeEngine,
    "imbalance_detector": ImbalanceDetectorEngine,
}

# Configuração por símbolo (price_step para footprint/imbalance)
SYMBOL_ENGINE_CONFIG = {
    'BTCUSD':  {'price_step': 10.0},
    'XAUUSD':  {'price_step': 0.50},
    'EURUSD':  {'price_step': 0.0001},
    'GBPUSD':  {'price_step': 0.0001},
    'USTEC':   {'price_step': 1.0},
    'US100':   {'price_step': 1.0},
    'NAS100':  {'price_step': 1.0},
}

class VolumeEngineOrchestrator:
    def __init__(self, engine_names=None, config=None, symbol='EURUSD'):
        self.config = config or {}
        self.symbol = symbol
        self.engines: Dict[str, VolumeEngine] = {}
        
        sym_cfg = SYMBOL_ENGINE_CONFIG.get(symbol.upper(), {'price_step': 0.0001})
        
        names = engine_names or list(ENGINE_REGISTRY.keys())
        for name in names:
            if name in ENGINE_REGISTRY:
                eng_config = {**self.config.get(name, {})}
                # Inject symbol-specific price_step for imbalance_detector
                if name == 'imbalance_detector':
                    eng_config.setdefault('price_step', sym_cfg['price_step'])
                self.engines[name] = ENGINE_REGISTRY[name](eng_config)
    
    def analyze_tick(self, tick: Dict[str, Any]) -> Dict[str, Any]:
        """Analisa tick com todos os engines. Volume permanece intacto."""
        context = {'symbol': self.symbol}
        
        results = {}
        composite_signals = []
        
        is_absorption = False
        absorption_type = None
        absorption_strength = 0
        stacking_buy = 0
        stacking_sell = 0
        
        for name, engine in self.engines.items():
            try:
                result = engine.analyze(tick, context)
                results[name] = result
                
                if 'signal' in result:
                    composite_signals.append(result['signal'])
                
                # Aggregate key signals
                if name == 'micro_cluster':
                    if result.get('is_absorption'):
                        is_absorption = True
                        absorption_type = result.get('absorption_type')
                        absorption_strength = result.get('absorption_strength', 0)
                
                if name == 'imbalance_detector':
                    stacking_buy = max(stacking_buy, result.get('stacking_buy', 0))
                    stacking_sell = max(stacking_sell, result.get('stacking_sell', 0))
                    
            except Exception as e:
                results[name] = {'signal': 0.0, 'error': str(e)}
        
        composite = sum(composite_signals) / len(composite_signals) if composite_signals else 0
        
        return {
            'volume': tick.get('volume_synthetic', 1),
            'side': tick.get('side', 'buy'),
            'is_absorption': is_absorption,
            'absorption_type': absorption_type,
            'absorption_strength': absorption_strength,
            'stacking_buy': stacking_buy,
            'stacking_sell': stacking_sell,
            'composite_signal': round(composite, 3),
            'engines': results,
        }
    
    def switch_symbol(self, symbol):
        """Troca símbolo e reconfigura engines."""
        self.symbol = symbol.upper()
        sym_cfg = SYMBOL_ENGINE_CONFIG.get(self.symbol, {'price_step': 0.0001})
        
        for name, engine in self.engines.items():
            engine.reset()
            if name == 'imbalance_detector' and hasattr(engine, 'price_step'):
                engine.price_step = sym_cfg['price_step']
    
    def set_weight_mode(self, mode):
        """Muda modo de ponderação nos engines que suportam."""
        for engine in self.engines.values():
            if hasattr(engine, 'set_weight_mode'):
                engine.set_weight_mode(mode)
