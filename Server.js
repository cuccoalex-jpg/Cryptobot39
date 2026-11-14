const express = require('express');
const axios = require('axios');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;
const API_KEY = process.env.API_KEY || '';
const API_SECRET = process.env.API_SECRET || '';
const CMC_API_KEY = process.env.CMC_API_KEY || '';

const exchange = new ccxt.kraken({
    apiKey: API_KEY,
    secret: API_SECRET,
    enableRateLimit: true,
});

let botRunning = true;
let lastLog = "Bot avviato con Scansione Completa Multi-Asset (Top CMC + Kraken, Analisi Ipercomprato/Trend, Supporti/Resistenze, Fee Kraken, SL/TP dinamici BTC).";

// Dashboard di stato su Render
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Strategia Completa Master:</b> Scansione Totale CMC & Kraken, Analisi Ipercomprato/Forza & Supporti/Resistenze, SL/TP dinamici su BTC, Fee Check & Micro-lotti.</p>
            </body>
        </html>
    `);
});

// Toggle ON/OFF
app.post('/api/toggle', (req, res) => {
    botRunning = !botRunning;
    lastLog = `Bot ${botRunning ? 'riattivato' : 'messo in pausa'} via API.`;
    res.json({ success: true, botRunning, message: lastLog });
});

// Calcolo RSI sicuro
function calculateRSI(closes, period = 14) {
    if (!closes || closes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const change = closes[closes.length - i] - closes[closes.length - i - 1];
        if (change > 0) gains += change;
        else losses -= change;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    let rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

// Calcolo Media Mobile (SMA) sicuro
function calculateSMA(closes, period) {
    if (!closes || closes.length < period) return closes ? closes[closes.length - 1] : 0;
    const slice = closes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

// Rilevamento Supporti e Resistenze geometriche avanzate
function findSupportAndResistance(ohlcv) {
    if (!ohlcv || ohlcv.length < 20) return { support: 0, resistance: 0 };
    const lows = ohlcv.map(c => c[3]); 
    const highs = ohlcv.map(c => c[2]); 
    const support = Math.min(...lows.slice(-20)); 
    const resistance = Math.max(...highs.slice(-20)); 
    return { support, resistance };
}

// Rilevamento Pattern di Prezzo
function detectChartPatterns(ohlcv) {
    if (!ohlcv || ohlcv.length < 15) return { pattern: "NONE", score: 0 };
    
    const closes = ohlcv.map(c => c[4]);
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    
    let pattern = "NORMAL_ACTION";
    let score = 0;

    const currentClose = closes[closes.length - 1];
    const recentMin = Math.min(...lows.slice(-10));
    
    if (Math.abs(currentClose - recentMin) / recentMin < 0.01) {
        pattern = "SUPPORT_BOUNCE";
        score += 2;
    }

    const p = highs.slice(-15);
    const mid = Math.floor(p.length / 2);
    if (p[mid] > p[0] && p[mid] > p[p.length - 1] && p[mid] > p[mid - 2] && p[mid] > p[mid + 2]) {
        pattern = "HEAD_AND_SHOULDERS_FORMING";
        score += 3;
    }

    return { pattern, score };
}

// Funzione principale del Bot (Gira 24/7 in background)
async function runBotLoop() {
    while (true) {
        try {
            if (botRunning) {
                const now = new Date().toLocaleString();
                await exchange.loadMarkets();

                // 1. Lettura Saldi su Kraken
                const balance = await exchange.fetchBalance();
                const eurBalance = balance.free['EUR'] || 0;
                console.log(`[${now}] Saldo disponibile EUR: €${eurBalance.toFixed(2)}`);

                // 2. Termometro BTC & Analisi del Trend (TF 15m)
                let isBtcBullish = true;
                try {
                    const btcOhlcv = await exchange.fetchOHLCV('BTC/EUR', '15m', undefined, 50);
                    const btcCloses = btcOhlcv.map(c => c[4]);
                    const btcRsi = calculateRSI(btcCloses);
                    const btcPrice = btcCloses[btcCloses.length - 1];
                    const btcSma20 = calculateSMA(btcCloses, 20);

                    isBtcBullish = (btcPrice >= btcSma20 && btcRsi >= 45);

                    lastLog = `[${now}] BTC a €${btcPrice.toFixed(2)} (RSI: ${btcRsi.toFixed(1)}) | Trend: ${isBtcBullish ? 'POSITIVO (Bullish)' : 'NEGATIVO (Bearish)'}`;
                    console.log(lastLog);
                } catch (btcErr) {
                    console.log(`[${now}] Errore termometro BTC:`, btcErr.message);
                }

                // Soglie SL e TP dinamiche basate rigorosamente sul trend di BTC
                const dynamicStopLoss = isBtcBullish ? -5.0 : -2.0;    
                const dynamicTakeProfit = isBtcBullish ? 2.0 : 1.0;     

                // 3. Monitoraggio posizioni aperte (TP & SL dinamici effettivi)
                const activeAssets = ['ETH/EUR', 'SOL/EUR', 'XRP/EUR', 'ADA/EUR', 'AVAX/EUR', 'LINK/EUR'];
                for (const symbol of activeAssets) {
                    try {
                        const baseCurrency = symbol.split('/')[0];
                        const assetBalance = balance.free[baseCurrency] || 0;
                        
                        if (assetBalance > 0.0001 && exchange.markets[symbol]) {
                            const ticker = await exchange.fetchTicker(symbol);
                            const currentPrice = ticker.last;

                            let entryPrice = currentPrice;
                            try {
                                const trades = await exchange.fetchMyTrades(symbol, undefined, 5);
                                const buyTrades = trades.filter(t => t.side === 'buy');
                                if (buyTrades.length > 0) {
                                    entryPrice = buyTrades[buyTrades.length - 1].price;
                                }
                            } catch (e) {}

                            const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
                            console.log(`[Posizione] ${symbol} | Ingresso: €${entryPrice.toFixed(2)} | Attuale: €${currentPrice.toFixed(2)} | P&L: ${pnlPercent.toFixed(2)}% [SL: ${dynamicStopLoss}%, TP: ${dynamicTakeProfit}%]`);

                            if (pnlPercent >= dynamicTakeProfit) {
                                console.log(`[TAKE-PROFIT] Target raggiunto su ${symbol} (+${pnlPercent.toFixed(2)}%). Vendita in corso...`);
                                const sellOrder = await exchange.createMarketSellOrder(symbol, assetBalance);
                                console.log(`[SUCCESSO VENDITA] TP eseguito! ID:`, sellOrder.id);
                                lastLog = `[${now}] Take-Profit eseguito su ${symbol} (+${pnlPercent.toFixed(2)}%)`;
                                await new Promise(resolve => setTimeout(resolve, 60000));
                                break;
                            } else if (pnlPercent <= dynamicStopLoss) {
                                console.log(`[STOP-LOSS] Soglia di protezione raggiunta su ${symbol} (${pnlPercent.toFixed(2)}%). Chiusura in corso...`);
                                const sellOrder = await exchange.createMarketSellOrder(symbol, assetBalance);
                                console.log(`[SUCCESSO STOP-LOSS] SL eseguito! ID:`, sellOrder.id);
                                lastLog = `[${now}] Stop-Loss eseguito su ${symbol} (${pnlPercent.toFixed(2)}%)`;
                                await new Promise(resolve => setTimeout(resolve, 60000));
                                break;
                            }
                        }
                    } catch (posErr) {
                        console.log(`Errore monitoraggio ${symbol}:`, posErr.message);
                    }
                }

                // 4. SCANSIONE COMPLETA: Unione di tutte le crypto da CoinMarketCap + Lista nativa Kraken in EUR
                let dynamicAssets = ['ETH/EUR', 'SOL/EUR', 'XRP/EUR', 'ADA/EUR', 'AVAX/EUR', 'LINK/EUR', 'DOT/EUR', 'MATIC/EUR', 'UNI/EUR', 'ATOM/EUR'];
                if (CMC_API_KEY) {
                    try {
                        const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                            headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                            params: { start: 1, limit: 50, convert: 'USD' }
                        });
                        const cmcCoins = cmcResponse.data.data;
                        const topSymbols = cmcCoins.map(coin => `${coin.symbol}/EUR`);
                        const validCmcAssets = topSymbols.filter(sym => exchange.markets[sym]);
                        // Unisce e rimuove i doppioni
                        dynamicAssets = Array.from(new Set([...validCmcAssets, ...dynamicAssets]));
                    } catch (cmcErr) {
                        console.log("Errore recupero CoinMarketCap, uso paniere Kraken predefinito.");
                    }
                }

                // 5. ANALISI MASTER MASTER: Sfoglia tutto, valuta ipervenduto, ipercomprato, resistenze, supporti e momentum
                for (const symbol of dynamicAssets) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        
                        const ohlcv5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 30);
                        const ohlcv15m = await exchange.fetchOHLCV(symbol, '15m', undefined, 30);
                        const ohlcv1h = await exchange.fetchOHLCV(symbol, '1h', undefined, 30);

                        const closes5m = ohlcv5m.map(c => c[4]);
                        const closes15m = ohlcv15m.map(c => c[4]);
                        const closes1h = ohlcv1h.map(c => c[4]);

                        const rsi5m = calculateRSI(closes5m);
                        const rsi15m = calculateRSI(closes15m);
                        const currentPrice = closes5m[closes5m.length - 1];

                        const sma20_1h = calculateSMA(closes1h, 20);
                        const { support, resistance } = findSupportAndResistance(ohlcv15m);
                        const { pattern, score } = detectChartPatterns(ohlcv15m);

                        // Taglia dell'investimento: micro-lotti (6€) se ribassista, standard (12€) se rialzista
                        let targetInvestmentSize = isBtcBullish ? 12 : 6; 
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        // Condizioni di analisi completa:
                        const nearSupport = support > 0 && (currentPrice <= support * 1.015);
                        const isOversold = (rsi5m < 30 || rsi15m < 38); // Ipervenduto
                        
                        // Valutazione Ipercomprato / Forza / Breakout di Resistenza
                        const isOverboughtStrong = (rsi5m > 65 && rsi15m > 60 && currentPrice >= resistance * 0.99); // In ipercomprato vicino alla resistenza o in pieno breakout

                        let buyCondition = false;
                        let reason = "";

                        if (!isBtcBullish) {
                            // In mercato ribassista predilige i supporti e l'ipervenduto
                            if (nearSupport || isOversold || score >= 2) {
                                buyCondition = (eurBalance >= 5);
                                reason = nearSupport ? "Test Supporto (Bearish)" : "Ipervenduto Profondo";
                            }
                        } else {
                            // In mercato rialzista cerca tutto: ipervenduto, supporti, ma ANALIZZA ANCHE GLI IPERCOMPRATI E I BREAKOUT DI RESISTENZA!
                            if (isOverboughtStrong) {
                                buyCondition = (eurBalance >= 5);
                                reason = `Ipercomprato in Breakout su Resistenza (€${resistance.toFixed(2)})`;
                            } else if (nearSupport || isOversold) {
                                buyCondition = (eurBalance >= 5);
                                reason = nearSupport ? "Rimbalzo da Supporto" : "Ipervenduto a Sconto";
                            }
                        }

                        if (buyCondition) {
                            const estimatedFeePercent = 0.005; 
                            const netTargetPrice = currentPrice * (1 + estimatedFeePercent + (dynamicTakeProfit / 100));

                            console.log(`[Analisi Master] Trovata opportunità su ${symbol} | Motivo: ${reason} | RSI(5m): ${rsi5m.toFixed(1)} | Supporto: €${support.toFixed(2)} | Resistenza: €${resistance.toFixed(2)} | Prezzo: €${currentPrice} | Target Netto: €${netTargetPrice.toFixed(4)}`);

                            const amountToBuy = targetInvestmentSize / currentPrice;
                            const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                            
                            console.log(`[SUCCESSO ACQUISTO MASTER] Acquistati ~€${targetInvestmentSize} di ${symbol} a €${currentPrice} (${reason})! ID:`, order.id);
                            lastLog = `[${now}] Acquistati €${targetInvestmentSize} di ${symbol} (${reason})`;
                            
                            await new Promise(resolve => setTimeout(resolve, 60000));
                            break;
                        }
                    } catch (altErr) {
                        // Salta l'asset in caso di errore temporaneo e continua la scansione sugli altri
                    }
                }
            }
        } catch (err) {
            console.log("Errore nel ciclo principale del bot:", err.message);
        }

        // Intervallo di scansione (3 minuti)
        await new Promise(resolve => setTimeout(resolve, 180000));
    }
}

app.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
    runBotLoop();
});
