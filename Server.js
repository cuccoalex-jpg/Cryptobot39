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
let lastLog = "Bot avviato: Watchlist Outperformer + Panic Switch Chirurgico + Scansione Universale EUR.";

// Memoria temporanea per monitorare le Outperformer uscite durante il panico pronte al rientro
let watchedOutperformers = [];

// Dashboard di stato su Render
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Watchlist Outperformer:</b> ${watchedOutperformers.length > 0 ? watchedOutperformers.join(', ') : 'Nessuna in attesa di rientro'}</p>
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

// Analisi tecnica avanzata di pattern e conferma candela verde
function detectChartPatterns(ohlcv) {
    if (!ohlcv || ohlcv.length < 15) return { pattern: "NONE", score: 0, isGreenCandle: false };
    
    const lastCandle = ohlcv[ohlcv.length - 1];
    const isGreenCandle = lastCandle[4] > lastCandle[1]; // Chiusura > Apertura
    
    const closes = ohlcv.map(c => c[4]);
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    
    let pattern = "NORMAL_ACTION";
    let score = 0;

    const currentClose = closes[closes.length - 1];
    const recentMin = Math.min(...lows.slice(-10));
    
    if (Math.abs(currentClose - recentMin) / recentMin < 0.01 && isGreenCandle) {
        pattern = "SUPPORT_BOUNCE_CONFIRMED";
        score += 3;
    }

    return { pattern, score, isGreenCandle };
}

// Controllo Sentiment Macro globale
async function getMacroSentiment() {
    try {
        const fngRes = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 4000 });
        const fngValue = parseInt(fngRes.data.data[0].value, 10);
        const fngClassification = fngRes.data.data[0].value_classification;
        return { value: fngValue, label: fngClassification, isExtremeFear: fngValue <= 20 };
    } catch (e) {
        return { value: 50, label: "Neutral", isExtremeFear: false };
    }
}

// Funzione principale del Bot (Gira 24/7 in background)
async function runBotLoop() {
    while (true) {
        try {
            if (botRunning) {
                const now = new Date().toLocaleString();
                await exchange.loadMarkets();

                // 1. Lettura Saldi su Kraken (in EUR)
                const balance = await exchange.fetchBalance();
                const eurBalance = balance.free['EUR'] || 0;
                console.log(`[${now}] Saldo disponibile EUR: €${eurBalance.toFixed(2)}`);

                // 2. Sentiment Macro
                const macro = await getMacroSentiment();

                // 3. Termometro BTC & Rilevamento Panic Crash
                let isBtcBullish = true;
                let isPanicCrash = false;
                let btcChange1h = 0;

                try {
                    const btcOhlcv15m = await exchange.fetchOHLCV('BTC/EUR', '15m', undefined, 50);
                    const btcOhlcv1h = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 5);
                    
                    const btcCloses15m = btcOhlcv15m.map(c => c[4]);
                    const btcRsi15m = calculateRSI(btcCloses15m, 14);
                    const btcPrice = btcCloses15m[btcCloses15m.length - 1];
                    const btcSma20 = calculateSMA(btcCloses15m, 20);

                    const btcOpen1h = btcOhlcv1h[btcOhlcv1h.length - 1][1];
                    btcChange1h = ((btcPrice - btcOpen1h) / btcOpen1h) * 100;

                    isBtcBullish = (btcPrice >= btcSma20 && btcRsi15m >= 45);
                    isPanicCrash = (btcChange1h <= -4.0) || (btcChange1h <= -3.0 && macro.isExtremeFear);

                    const statusLabel = isPanicCrash 
                        ? `🚨 PANIC CRASH (${btcChange1h.toFixed(2)}% in 1h)` 
                        : (isBtcBullish ? 'BULLISH' : 'BEARISH / CAUTELA');

                    lastLog = `[${now}] BTC: €${btcPrice.toFixed(2)} (1h: ${btcChange1h.toFixed(2)}%) | Watchlist Outperformer: ${watchedOutperformers.length} asset | Stato: ${statusLabel}`;
                    console.log(lastLog);
                } catch (btcErr) {
                    console.log(`[${now}] Errore termometro BTC:`, btcErr.message);
                }

                const dynamicStopLoss = isBtcBullish ? -5.0 : -2.0;    
                const dynamicTakeProfit = isBtcBullish ? 2.0 : 1.0;     

                // 4. SCANSIONE COINMARKETCAP & TOP GAINER (24h)
                let allKrakenPairs = Object.keys(exchange.markets).filter(symbol => symbol.endsWith('/EUR') && exchange.markets[symbol].active);
                let dynamicAssets = allKrakenPairs;
                let cmcPerformanceMap = {};

                if (CMC_API_KEY) {
                    try {
                        const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                            headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                            params: { start: 1, limit: 100, sort: 'percent_change_24h', sort_dir: 'desc', convert: 'USD' }
                        });
                        const cmcCoins = cmcResponse.data.data;
                        const topSymbols = [];
                        for (const coin of cmcCoins) {
                            const sym = `${coin.symbol}/EUR`;
                            topSymbols.push(sym);
                            cmcPerformanceMap[sym] = coin.quote?.USD?.percent_change_24h || 0;
                        }
                        
                        const validCmcAssets = topSymbols.filter(sym => exchange.markets[sym] && exchange.markets[sym].active);
                        const remainingPairs = allKrakenPairs.filter(sym => !validCmcAssets.includes(sym));
                        dynamicAssets = [...validCmcAssets, ...remainingPairs];
                    } catch (cmcErr) {}
                }

                // 5. MONITORAGGIO GLOBALE POSIZIONI APERTE + AGGIUNTA ALLA WATCHLIST SE OUTPERFORMER ESCE DURANTE PANIC
                for (const symbol of dynamicAssets) {
                    try {
                        const baseCurrency = symbol.split('/')[0];
                        const assetBalance = balance.free[baseCurrency] || 0;
                        
                        if (assetBalance > 0.0001) {
                            const ticker = await exchange.fetchTicker(symbol);
                            const currentPrice = ticker.last;

                            let entryPrice = currentPrice;
                            try {
                                const trades = await exchange.fetchMyTrades(symbol, undefined, 5);
                                const buyTrades = trades.filter(t => t.side === 'buy');
                                if (buyTrades.length > 0) entryPrice = buyTrades[buyTrades.length - 1].price;
                            } catch (e) {}

                            const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

                            // GESTIONE PANIC KILL SWITCH CHIRURGICA CON AGGIORNAMENTO WATCHLIST
                            if (isPanicCrash) {
                                if (pnlPercent < 1.2) {
                                    console.log(`[🚨 PANIC EXIT] Crollo BTC! Liquidazione su ${symbol} (${pnlPercent.toFixed(2)}%).`);
                                    await exchange.createMarketSellOrder(symbol, assetBalance);
                                    
                                    // Se era un titolo forte (performance 24h positiva), lo metto in Watchlist per seguirlo nel rimbalzo!
                                    if ((cmcPerformanceMap[symbol] || 0) > 2.0 && !watchedOutperformers.includes(symbol)) {
                                        watchedOutperformers.push(symbol);
                                        console.log(`[⭐ WATCHLIST] ${symbol} aggiunto alla watchlist delle outperformer da monitorare per il rientro.`);
                                    }

                                    lastLog = `[${now}] PANIC EXIT su ${symbol}`;
                                    await new Promise(resolve => setTimeout(resolve, 60000));
                                    break;
                                } else {
                                    console.log(`[🛡️ VINCENTE PROTETTA] ${symbol} regge a +${pnlPercent.toFixed(2)}%.`);
                                    if (pnlPercent >= dynamicTakeProfit + 1.5) {
                                        await exchange.createMarketSellOrder(symbol, assetBalance);
                                        break;
                                    }
                                    continue;
                                }
                            }

                            // GESTIONE ORDINARIA TP / SL
                            if (pnlPercent >= dynamicTakeProfit) {
                                console.log(`[TAKE-PROFIT] Target raggiunto su ${symbol} (+${pnlPercent.toFixed(2)}%).`);
                                await exchange.createMarketSellOrder(symbol, assetBalance);
                                // Se ha chiuso in profitto con ottima performance, lo annotiamo nella watchlist
                                if ((cmcPerformanceMap[symbol] || 0) > 3.0 && !watchedOutperformers.includes(symbol)) {
                                    watchedOutperformers.push(symbol);
                                }
                                await new Promise(resolve => setTimeout(resolve, 60000));
                                break;
                            } else if (pnlPercent <= dynamicStopLoss) {
                                console.log(`[STOP-LOSS] Soglia raggiunta su ${symbol} (${pnlPercent.toFixed(2)}%).`);
                                await exchange.createMarketSellOrder(symbol, assetBalance);
                                await new Promise(resolve => setTimeout(resolve, 60000));
                                break;
                            }
                        }
                    } catch (posErr) {
                        console.log(`Errore monitoraggio ${symbol}:`, posErr.message);
                    }
                }

                // 6. SCANSIONE PRIORITARIA WATCHLIST OUTPERFORMER + SCANSIONE UNIVERSALE TOP GAINER
                // Prima controlla se c'è un'occasione di rientro sulle outperformer monitorate
                let prioritizedAssets = [...new Set([...watchedOutperformers, ...dynamicAssets])];

                for (const symbol of prioritizedAssets) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        
                        const baseCurrency = symbol.split('/')[0];
                        if (balance.free[baseCurrency] && balance.free[baseCurrency] > 0.0001) {
                            // Se lo abbiamo già comprato, lo rimuoviamo dalla watchlist in attesa di rientro
                            watchedOutperformers = watchedOutperformers.filter(s => s !== symbol);
                            continue; 
                        }

                        const perf24h = cmcPerformanceMap[symbol] || 0;
                        if (isPanicCrash && perf24h < 4.5 && !watchedOutperformers.includes(symbol)) {
                            continue;
                        }

                        const ohlcv5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 30);
                        const ohlcv15m = await exchange.fetchOHLCV(symbol, '15m', undefined, 30);
                        const ohlcv1h = await exchange.fetchOHLCV(symbol, '1h', undefined, 30);

                        const closes5m = ohlcv5m.map(c => c[4]);
                        const closes15m = ohlcv15m.map(c => c[4]);
                        const closes1h = ohlcv1h.map(c => c[4]);

                        const rsi5m = calculateRSI(closes5m, 14);
                        const rsi15m = calculateRSI(closes15m, 14);
                        const currentPrice = closes5m[closes5m.length - 1];

                        const { support, resistance } = findSupportAndResistance(ohlcv15m);
                        const { score, isGreenCandle } = detectChartPatterns(ohlcv5m);

                        let targetInvestmentSize = (isBtcBullish && !macro.isExtremeFear && !isPanicCrash) ? 12 : 5; 
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        // Filtro obbligatorio candela verde di rimbalzo
                        if (!isGreenCandle) continue;

                        const isWatchedOutperformer = watchedOutperformers.includes(symbol);
                        const nearSupport = support > 0 && (currentPrice <= support * 1.02);
                        const isOversold = (rsi5m < 34 || rsi15m < 38);
                        const strongMomentum = (rsi5m > 56 && rsi5m < 72 && rsi15m > 52);

                        let buyCondition = false;
                        let reason = "";

                        // Se il titolo è nella nostra Watchlist delle Outperformer, appena mostra reazione e candela verde rientriamo subito!
                        if (isWatchedOutperformer && (isGreenCandle || nearSupport)) {
                            buyCondition = (eurBalance >= 5);
                            reason = `Reingresso Prioritario su Outperformer Monitorata (${perf24h.toFixed(1)}% 24h)`;
                            // Rimuove dalla watchlist una volta rientrato
                            watchedOutperformers = watchedOutperformers.filter(s => s !== symbol);
                        } else if (!isPanicCrash) {
                            if (strongMomentum || nearSupport || isOversold) {
                                buyCondition = (eurBalance >= 5);
                                reason = strongMomentum ? "Slancio Top Gainer (Multi-TF)" : "Supporto Tecnico Confermato";
                            }
                        }

                        if (buyCondition) {
                            console.log(`[Acquisto Mirato] Trovata occasione su ${symbol} | Motivo: ${reason} | Prezzo: €${currentPrice}`);

                            const amountToBuy = targetInvestmentSize / currentPrice;
                            const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                            
                            console.log(`[SUCCESSO ACQUISTO] Acquistati ~€${targetInvestmentSize} di ${symbol} (${reason})! ID:`, order.id);
                            lastLog = `[${now}] Acquistati €${targetInvestmentSize} di ${symbol} (${reason})`;
                            
                            await new Promise(resolve => setTimeout(resolve, 60000));
                            break;
                        }
                    } catch (altErr) {}
                }
            }
        } catch (err) {
            console.log("Errore nel ciclo principale del bot:", err.message);
        }

        await new Promise(resolve => setTimeout(resolve, 180000));
    }
}

app.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
    runBotLoop();
});
