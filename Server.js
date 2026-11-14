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
let lastLog = "Bot avviato con Analisi Tecnica Completa (Supporti/Resistenze, Testa e Spalle, Pattern, SL/TP dinamici BTC, Multi-SMA, Multi-token e Micro-lotti).";

// Dashboard di stato su Render
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Strategia Integrale:</b> Supporti/Resistenze, Pattern di Prezzo, SL/TP dinamici su BTC, Multi-SMA, Multi-Token & Micro-lotti.</p>
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

// Calcolo RSI
function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
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

// Calcolo Media Mobile (SMA)
function calculateSMA(closes, period) {
    if (closes.length < period) return closes[closes.length - 1];
    const slice = closes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

// Rilevamento Supporti e Resistenze dai massimi/minimi recenti
function findSupportAndResistance(ohlcv) {
    const lows = ohlcv.map(c => c[3]); // Prezzi minimi
    const highs = ohlcv.map(c => c[2]); // Prezzi massimi
    const support = Math.min(...lows.slice(-20)); // Minimo delle ultime 20 candele
    const resistance = Math.max(...highs.slice(-20)); // Massimo delle ultime 20 candele
    return { support, resistance };
}

// Rilevamento Pattern di Prezzo (es. Testa e Spalle di inversione / Rimbalzo su supporto)
function detectChartPatterns(ohlcv) {
    if (ohlcv.length < 15) return { pattern: "NONE", score: 0 };
    
    const closes = ohlcv.map(c => c[4]);
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    
    let pattern = "NORMAL_ACTION";
    let score = 0;

    // Semplificazione algoritmica per individuare pattern di Testa e Spalle ribassista/rialzistà o minimi crescenti
    const currentClose = closes[closes.length - 1];
    const recentMin = Math.min(...lows.slice(-10));
    
    // Controllo rimbalzo pulito su supporto (doppio minimo o test di supporto)
    if (Math.abs(currentClose - recentMin) / recentMin < 0.01) {
        pattern = "SUPPORT_BOUNCE";
        score += 2;
    }

    // Controllo struttura a campana / Testa e Spalle abbozzato sulle ultime 15 candele
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

                // 2. Termometro BTC & Analisi del Trend (Positivo vs Negativo)
                let isBtcBullish = true;
                try {
                    const btcOhlcv = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 50);
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

                // Soglie Dinamiche SL e TP basate sul trend di BTC
                const dynamicStopLoss = isBtcBullish ? -5.0 : -2.0;    // -5% se positivo, -2% se negativo
                const dynamicTakeProfit = isBtcBullish ? 2.0 : 1.0;     // +2% o più se positivo, +1% se negativo

                // 3. Monitoraggio posizioni aperte (TP & SL dinamici)
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

                // 4. CoinMarketCap & Multi-Token Discovery
                let dynamicAssets = ['ETH/EUR', 'SOL/EUR', 'XRP/EUR', 'ADA/EUR', 'AVAX/EUR', 'LINK/EUR'];
                if (CMC_API_KEY) {
                    try {
                        const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                            headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                            params: { start: 1, limit: 30, convert: 'USD' }
                        });
                        const cmcCoins = cmcResponse.data.data;
                        const topSymbols = cmcCoins.map(coin => `${coin.symbol}/EUR`);
                        const validCmcAssets = topSymbols.filter(sym => exchange.markets[sym]);
                        if (validCmcAssets.length > 0) dynamicAssets = validCmcAssets;
                    } catch (cmcErr) {}
                }

                // 5. Scansione Multi-Token con Analisi Tecnica Completa (Supporti/Resistenze, Pattern, Multi-SMA, RSI) & Micro-lotti
                for (const symbol of dynamicAssets) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        
                        const ohlcv = await exchange.fetchOHLCV(symbol, '1h', undefined, 50);
                        const closes = ohlcv.map(c => c[4]);
                        const rsi = calculateRSI(closes);
                        const currentPrice = closes[closes.length - 1];
                        
                        // Medie mobili multi-periodo
                        const sma7 = calculateSMA(closes, 7);
                        const sma20 = calculateSMA(closes, 20);
                        const sma50 = calculateSMA(closes, 50);

                        // Analisi Supporti, Resistenze e Pattern Grafici
                        const { support, resistance } = findSupportAndResistance(ohlcv);
                        const { pattern, score } = detectChartPatterns(ohlcv);

                        // Taglia dell'investimento: micro-lotti prudenti (6€) se ribassista, standard (12€) se rialzista
                        let targetInvestmentSize = isBtcBullish ? 12 : 6; 
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        // Condizioni d'ingresso avanzate con confluenza di Supporti, Pattern e Indicatori:
                        let buyCondition = false;
                        const nearSupport = (currentPrice <= support * 1.02); // Prezzo vicino o test del supporto

                        if (!isBtcBullish) {
                            // In mercato ribassista: compra solo se siamo vicini a un supporto chiave, c'è un pattern favorevole o RSI molto basso
                            buyCondition = (nearSupport || rsi < 32 || score >= 2) && eurBalance >= 5;
                        } else {
                            // In mercato rialzista: ottime occasioni su rimbalzi dai supporti o RSI in ipervenduto/medie mobili
                            buyCondition = (nearSupport || rsi < 40 || currentPrice < sma20) && eurBalance >= 5;
                        }

                        if (buyCondition) {
                            const estimatedFeePercent = 0.005; 
                            const netTargetPrice = currentPrice * (1 + estimatedFeePercent + (dynamicTakeProfit / 100));

                            console.log(`[Segnale Avanzato] ${symbol} | Pattern: ${pattern} | Supporto: €${support.toFixed(2)} | Resistenza: €${resistance.toFixed(2)} | RSI: ${rsi.toFixed(1)} | Prezzo: €${currentPrice} | Investimento: €${targetInvestmentSize}`);

                            const amountToBuy = targetInvestmentSize / currentPrice;
                            const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                            
                            console.log(`[SUCCESSO ACQUISTO] Acquistati ~€${targetInvestmentSize} di ${symbol} a €${currentPrice}! ID:`, order.id);
                            lastLog = `[${now}] Acquistati €${targetInvestmentSize} di ${symbol} (Pattern: ${pattern}, Supporto testato)`;
                            
                            await new Promise(resolve => setTimeout(resolve, 60000));
                            break;
                        }
                    } catch (altErr) {
                        // Prosegue la scansione sugli altri token in caso di errore
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
