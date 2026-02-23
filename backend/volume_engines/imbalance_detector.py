"""
ImbalanceDetectorEngine — Detecção diagonal de imbalances (estilo YuCluster)
ADAPTADO para tick volume ponderado no MT5.

Constrói mini-footprint por janela de ticks e detecta desequilíbrios
entre níveis de preço adjacentes.

Buy imbalance: volume ask no nível N >> volume bid no nível N+1
(comprador agressivo empurrando preço pra cima)

FUNCIONA com tick volume porque o que importa é a PROPORÇÃO,
não o valor absoluto.
"""
from collections import defaultdict, deque
from .base import VolumeEngine

class ImbalanceDetectorEngine(VolumeEngine):
    def __init__(self, config=None):
        cfg = config or {}
        self.price_step = cfg.get('price_step', 0.0001)  # Configurável por ativo
        self.imbalance_ratio = cfg.get('imbalance_ratio', 3.0)
        self.window_trades = cfg.get('window_trades', 50)
        self.min_stacking = cfg.get('min_stacking', 2)
        self.weight_mode = cfg.get('weight_mode', 'price_weighted')
        
        self.trade_buffer = deque(maxlen=self.window_trades)
        self.last_bid = 0
        self.last_ask = 0
        self.last_price = 0
    
    def _discretize(self, price):
        if self.price_step <= 0:
            return price
        return round(price / self.price_step) * self.price_step
    
    def _calc_weight(self, tick):
        if self.weight_mode == 'equal':
            return 1.0
        elif self.weight_mode == 'price_weighted':
            price = tick.get('price', 0)
            if self.last_price > 0 and price > 0:
                move = abs(price - self.last_price) / self.last_price
                return 1.0 + min(move * 100000, 10.0)
            return 1.0
        elif self.weight_mode == 'spread_weighted':
            spread = tick.get('spread', 0)
            if spread > 0:
                # Normalizar: spread típico varia por ativo
                return max(0.5, min(3.0, 1.0 / (spread * 10000 + 0.1)))
            return 1.0
        return 1.0
    
    def _infer_side(self, tick):
        side = tick.get('side', '')
        if side in ('buy', 'sell'):
            return side
        
        bid = tick.get('bid', 0)
        ask = tick.get('ask', 0)
        
        if self.last_bid == 0:
            self.last_bid = bid
            self.last_ask = ask
            return 'buy'
        
        bid_change = bid - self.last_bid
        ask_change = ask - self.last_ask
        self.last_bid = bid
        self.last_ask = ask
        
        if ask_change > 0 and abs(bid_change) < abs(ask_change) * 0.3:
            return 'buy'
        elif bid_change < 0 and abs(ask_change) < abs(bid_change) * 0.3:
            return 'sell'
        elif bid_change > 0:
            return 'buy'
        elif bid_change < 0:
            return 'sell'
        return 'buy'
    
    def _analyze_footprint(self):
        """Constrói mini-footprint e detecta imbalances diagonais."""
        if len(self.trade_buffer) < 10:
            return None
        
        # Build footprint: {price_level: {buy: weight, sell: weight}}
        levels = defaultdict(lambda: {'buy': 0.0, 'sell': 0.0})
        for t in self.trade_buffer:
            lvl = self._discretize(t['price'])
            if t['side'] == 'buy':
                levels[lvl]['buy'] += t['weight']
            else:
                levels[lvl]['sell'] += t['weight']
        
        # Sort by price
        sorted_levels = sorted(levels.items(), key=lambda x: x[0])
        
        if len(sorted_levels) < 2:
            return None
        
        # Detect diagonal imbalances
        imbalances = []
        for i in range(len(sorted_levels) - 1):
            price_low, vol_low = sorted_levels[i]
            price_high, vol_high = sorted_levels[i + 1]
            
            # Buy imbalance: ask vol at lower level >> bid vol at upper level
            if vol_low['buy'] > 0 and vol_high['sell'] > 0:
                ratio = vol_low['buy'] / vol_high['sell']
                if ratio >= self.imbalance_ratio:
                    imbalances.append({
                        'type': 'buy',
                        'price_low': price_low,
                        'price_high': price_high,
                        'ratio': round(ratio, 1),
                    })
            
            # Sell imbalance: bid vol at upper level >> ask vol at lower level
            if vol_high['sell'] > 0 and vol_low['buy'] > 0:
                ratio = vol_high['sell'] / vol_low['buy']
                if ratio >= self.imbalance_ratio:
                    imbalances.append({
                        'type': 'sell',
                        'price_low': price_low,
                        'price_high': price_high,
                        'ratio': round(ratio, 1),
                    })
        
        # Count stacking (consecutive imbalances in same direction)
        stacking_buy = 0
        stacking_sell = 0
        current_stack = 0
        current_dir = None
        
        for imb in imbalances:
            if imb['type'] == current_dir:
                current_stack += 1
            else:
                if current_dir == 'buy':
                    stacking_buy = max(stacking_buy, current_stack)
                elif current_dir == 'sell':
                    stacking_sell = max(stacking_sell, current_stack)
                current_dir = imb['type']
                current_stack = 1
        
        if current_dir == 'buy':
            stacking_buy = max(stacking_buy, current_stack)
        elif current_dir == 'sell':
            stacking_sell = max(stacking_sell, current_stack)
        
        dominant = None
        if stacking_buy >= self.min_stacking and stacking_buy > stacking_sell:
            dominant = 'buy'
        elif stacking_sell >= self.min_stacking and stacking_sell > stacking_buy:
            dominant = 'sell'
        
        signal = 0.0
        if dominant == 'buy' and stacking_buy >= self.min_stacking:
            signal = min(1.0, stacking_buy * 0.25)
        elif dominant == 'sell' and stacking_sell >= self.min_stacking:
            signal = -min(1.0, stacking_sell * 0.25)
        
        return {
            'signal': round(signal, 3),
            'imbalances': len(imbalances),
            'stacking_buy': stacking_buy,
            'stacking_sell': stacking_sell,
            'dominant_direction': dominant,
            'levels_analyzed': len(sorted_levels),
            'weight_mode': self.weight_mode,
        }
    
    def analyze(self, tick, context):
        side = self._infer_side(tick)
        weight = self._calc_weight(tick)
        self.last_price = tick.get('price', self.last_price)
        
        self.trade_buffer.append({
            'price': tick.get('price', 0),
            'side': side,
            'weight': weight,
        })
        
        # Analyze every window_trades ticks
        if len(self.trade_buffer) >= self.window_trades and len(self.trade_buffer) % 10 == 0:
            result = self._analyze_footprint()
            if result:
                return result
        
        return {
            'signal': 0.0,
            'imbalances': 0,
            'stacking_buy': 0,
            'stacking_sell': 0,
            'dominant_direction': None,
            'levels_analyzed': 0,
            'weight_mode': self.weight_mode,
        }
    
    def set_weight_mode(self, mode):
        if mode in ('equal', 'price_weighted', 'spread_weighted'):
            self.weight_mode = mode
    
    def reset(self):
        self.trade_buffer.clear()
        self.last_bid = 0
        self.last_ask = 0
        self.last_price = 0
