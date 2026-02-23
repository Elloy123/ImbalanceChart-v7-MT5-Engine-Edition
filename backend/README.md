# ImbalanceChart v7 — MT5 Engine Edition

## Estrutura
```
imbalancechart-v7/
├── backend/
│   ├── mt5_server.py          ← Servidor principal (roda tudo)
│   ├── engine_orchestrator.py ← Coordena os 5 engines
│   ├── requirements.txt
│   └── volume_engines/
│       ├── base.py
│       ├── tick_velocity.py    ← Velocidade de ticks/seg
│       ├── spread_weight.py    ← Regime de volatilidade
│       ├── micro_cluster.py    ← Absorção (tick volume ponderado)
│       ├── atr_normalize.py    ← ATR 5s candles
│       └── imbalance_detector.py ← Stacking diagonal
└── frontend/
    └── index.html             ← Frontend completo (standalone)
```

## Instalação

```bash
pip install MetaTrader5 websockets
```

## Uso

1. Abra o MT5 e logue na sua conta Exness
2. Execute:
```bash
cd backend
python mt5_server.py
```
3. Abra: http://localhost:8000

## Ativos Configurados
- XAUUSD (Ouro) — default
- BTCUSD (Bitcoin)
- EURUSD
- GBPUSD
- USTEC (Nasdaq)

## Novidades v7
- **Conexão MT5 Exness** (não mais Binance)
- **Tick volume ponderado** com 3 modos: Preço, Spread, Igual
- **Modo selecionável** no painel (⚖️ Peso)
- **Histórico de 1 dia** — carrega automaticamente ao conectar
- **Clusters persistentes** — closedClusters nunca são apagados
- **masterTicks** — reprocessa ao mudar threshold/priceStep
- **Multi-símbolo** com configs automáticas por ativo
- **Tick-rule** para inferência de side (bid/ask change)
