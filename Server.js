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
let lastLog = "Bot avviato: Risk Gate + Backtest Storico Prezzi + Watchlist Outperformer + Panic Switch.";

let watchedOutperformers = [];

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Watchlist Outperformer:</b> ${watchedOutperformers.length > 0 ? watchedOutperformers.join(', ') : 'Nessuna'}</p>
            </body>
        </html>
    `);
});

app.post('/api/toggle', (req, res) => {
    botRunning = !botRunning;
    lastLog = `Bot ${botRunning ? 'riattivato' : 'messo in pausa'} via API.`;
    res.json({ success: true, botRunning, message: lastLog });
});

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

function calculateSMA(closes, period) {
    if (!closes || closes.length < period) return closes ? closes[closes.length - 1] : 0;
    const slice = closes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

function findSupportAndResistance(ohlcv) {
    if (!ohlcv || ohlcv.length < 20) return { support: 0, resistance: 0 };
    const lows = ohlcv.map(c => c[3]); 
    const highs = ohlcv.map(c => c[2]); 
    const support = Math.min(...lows.slice(-20)); 
    const resistance = Math.max(...highs.slice(-20)); 
    return { support, resistance };
}

function detectChartPatterns(ohlcv) {
    if (!ohlcv || ohlcv.length < 15) return { pattern: "NONE", score: 0, isGreenCandle: false };
    const lastCandle = ohlcv[ohlcv.length - 1];
    const isGreenCandle = lastCandle[4] > lastCandle[1];
    const closes = ohlcv.map(c => c[4]);
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

async function getMacroSentiment() {
    try {
        const fngRes = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 4000 });
        const fngValue = parseInt(fngRes.data.data[0].value, 10);
        return { value: fngValue, label: fngRes.data.data[0].value_classification, isExtremeFear: fngValue <= 20 };
    } catch (e) {
        return { value: 50, label: "Neutral", isExtremeFear: false };
    }
}

// BACKTEST GEOMETRICO STORICO SUI PREZZI: Simula se in passato comprare a questo livello portava a profitto o stop-loss
async function backtestPriceLevel(ohlcv, targetPrice, takeProfitPct, stopLossPct) {
    if (!ohlcv || ohlcv.length < 30) return { winRate: 100, status: "PASSED" };
    
    let simulatedWins = 0;
    let simulatedLosses = 0;

    // Analizza lo storico candela per candela per vedere come si muoveva il prezzo partendo da livelli simili
    for (let i = 20; i < ohlcv.length - 5; i++) {
        const historicalEntry = ohlcv[i][4]; // Prezzo di chiusura della candela passata
        const futureCandles = ohlcv.slice(i + 1, i + 6); // Guarda le 5 candele successive

        let hitTP = false;
        let hitSL = false;

        for (const fc of futureCandles) {
            const high = fc[2];
            const low = fc[3];
            const tpPrice = historicalEntry * (1 + (takeProfitPct / 100));
            const slPrice = historicalEntry * (1 - (stopLossPct / 100));

            if (high >= tpPrice) { hitTP = true; break; }
            if (low <= slPrice) { hitSL = true; break; }
        }

        if (hitTP && !hitSL) simulatedWins++;
        else if (hitSL && !hitTP) simulatedLosses++;
    }

    const totalSims = simulatedWins + simulatedLosses;
    if (totalSims === 0) return { winRate: 100, status: "PASSED" };

    const winRate = (simulatedWins / totalSims) * 100;
    // Se lo storico di quel livello di prezzo ha una percentuale di successo inferiore al 40%, penalizza l'ingresso
    if (winRate < 40) {
        return { winRate, status: "PENALIZED" };
    }
    return { winRate, status: "PASSED" };
}

async function runBotLoop() {
    while (true) {
        try {
            if (botRunning) {
                const now = new Date().toLocaleString();
                await exchange.loadMarkets();

                // 1. Saldi su Kraken
                const balance = await exchange.fetchBalance();
                const eurBalance = balance.free['EUR'] || 0;
                console.log(`[${now}] Saldo disponibile EUR: €${eurBalance.toFixed(2)}`);

                // 2. Termometro BTC & Macro (Visibile nei log)
                const macro = await getMacroSentiment();
                let isBtcBullish = true;
                let isPanicCrash = false;
                let btcChange1h = 0;
                let btcPrice = 0;

                try {
                    const btcOhlcv15m = await exchange.fetchOHLCV('BTC/EUR', '15m', undefined, 50);
                    const btcOhlcv1h = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 5);
                    const btcCloses15m = btcOhlcv15m.map(c => c[4]);
                    const btcRsi15m = calculateRSI(btcCloses15m, 14);
                    btcPrice = btcCloses15m[btcCloses15m.length - 1];
                    const btcSma20 = calculateSMA(btcCloses15m, 20);

                    const btcOpen1h = btcOhlcv1h[btcOhlcv1h.length - 1][1];
                    btcChange1h = ((btcPrice - btcOpen1h) / btcOpen1h) * 100;

                    isBtcBullish = (btcPrice >= btcSma20 && btcRsi15m >= 45);
                    isPanicCrash = (btcChange1h <= -4.0) || (btcChange1h <= -3.0 && macro.isExtremeFear);

                    lastLog = `[${now}] 📊 Termometro BTC: €${btcPrice.toFixed(2)} | Variazione 1h: ${btcChange1h.toFixed(2)}% | RSI: ${btcRsi15m.toFixed(1)} | Stato: ${isPanicCrash ? '🚨 PANIC CRASH' : (isBtcBullish ? 'BULLISH' : 'BEARISH')}`;
                    console.log(lastLog);
                } catch (btcErr) {
                    console.log(`[${now}] ⚠️ Errore lettura termometro BTC:`, btcErr.message);
                }

                const dynamicStopLoss = isBtcBullish ? -5.0 : -2.0;    
                const dynamicTakeProfit = isBtcBullish ? 2.0 : 1.0;     

                // 3. Scansione CoinMarketCap & Top Gainer (Volumi 24h)
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
                        const validCmcAssets = topSymbols.filter(sym => exchange.markets[sym] && exchange.markets[symbol]?.active);
                        const remainingPairs = allKrakenPairs.filter(sym => !validCmcAssets.includes(sym));
                        dynamicAssets = [...validCmcAssets, ...remainingPairs];
                    } catch (e) {}
                }

                // 4. Monitoraggio Globale Portafoglio (DOT, ATOM, ecc.)
                const totalBalances = balance.total || {};
                for (const currency of Object.keys(totalBalances)) {
                    if (currency === 'EUR' || currency === 'ZEUR' || currency === 'KFEE') continue;
                    const totalAmount = balance.total[currency] || 0;
                    if (totalAmount > 0.0001) {
                        const symbol = `${currency}/EUR`;
                        if (!exchange.markets[symbol]) continue;

                        try {
                            const ticker = await exchange.fetchTicker(symbol);
                            const currentPrice = ticker.last;

                            let entryPrice = currentPrice;
                            try {
                                const trades = await exchange.fetchMyTrades(symbol, undefined, 5);
                                const buyTrades = trades.filter(t => t.side === 'buy');
                                if (buyTrades.length > 0) entryPrice = buyTrades[buyTrades.length - 1].price;
                            } catch (e) {}

                            const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
                            console.log(`[Portafoglio] ${symbol} | Qty: ${totalAmount} | Ingresso: €${entryPrice.toFixed(2)} | Attuale: €${currentPrice.toFixed(2)} | P&L: ${pnlPercent.toFixed(2)}%`);

                            const freeAmount = balance.free[currency] || 0;
                            if (freeAmount <= 0.0001) continue;

                            if (isPanicCrash) {
                                if (pnlPercent < 1.2) {
                                    console.log(`[🚨 PANIC EXIT] Crollo BTC! Liquidazione su ${symbol} (${pnlPercent.toFixed(2)}%)...`);
                                    await exchange.createMarketSellOrder(symbol, freeAmount);
                                    if ((cmcPerformanceMap[symbol] || 0) > 2.0 && !watchedOutperformers.includes(symbol)) {
                                        watchedOutperformers.push(symbol);
                                    }
                                    await new Promise(resolve => setTimeout(resolve, 30000));
                                    break;
                                } else {
                                    console.log(`[🛡️ VINCENTE PROTETTA] ${symbol} regge a +${pnlPercent.toFixed(2)}%.`);
                                    if (pnlPercent >= dynamicTakeProfit + 1.5) {
                                        await exchange.createMarketSellOrder(symbol, freeAmount);
                                        break;
                                    }
                                    continue;
                                }
                            }

                            if (pnlPercent >= dynamicTakeProfit) {
                                console.log(`[TAKE-PROFIT] Target raggiunto su ${symbol} (+${pnlPercent.toFixed(2)}%). Vendita...`);
                                await exchange.createMarketSellOrder(symbol, freeAmount);
                                if ((cmcPerformanceMap[symbol] || 0) > 3.0 && !watchedOutperformers.includes(symbol)) {
                                    watchedOutperformers.push(symbol);
                                }
                                await new Promise(resolve => setTimeout(resolve, 30000));
                                break;
                            } else if (pnlPercent <= dynamicStopLoss) {
                                console.log(`[STOP-LOSS] Soglia raggiunta su ${symbol} (${pnlPercent.toFixed(2)}%). Chiusura...`);
                                await exchange.createMarketSellOrder(symbol, freeAmount);
                                await new Promise(resolve => setTimeout(resolve, 30000));
                                break;
                            }
                        } catch (errPort) {
                            console.log(`Errore portafoglio ${symbol}:`, errPort.message);
                        }
                    }
                }

                // 5. RISK GATE & SCANSIONE ACQUISTI (Con Backtest Storico Prezzi + Diagnostica nei Log)
                let prioritizedAssets = [...new Set([...watchedOutperformers, ...dynamicAssets])];

                for (const symbol of prioritizedAssets) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        
                        const baseCurrency = symbol.split('/')[0];
                        if (balance.free[baseCurrency] && balance.free[baseCurrency] > 0.0001) {
                            watchedOutperformers = watchedOutperformers.filter(s => s !== symbol);
                            continue; 
                        }

                        const perf24h = cmcPerformanceMap[symbol] || 0;
                        if (isPanicCrash && perf24h < 4.5 && !watchedOutperformers.includes(symbol)) {
                            console.log(`[Risk Gate] ${symbol} scartato: crollo di mercato in corso e performance 24h insufficiente.`);
                            continue;
                        }

                        const ohlcv5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 30);
                        const ohlcv15m = await exchange.fetchOHLCV(symbol, '15m', undefined, 30);
                        const closes5m = ohlcv5m.map(c => c[4]);
                        const closes15m = ohlcv15m.map(c => c[4]);

                        const rsi5m = calculateRSI(closes5m, 14);
                        const rsi15m = calculateRSI(closes15m, 14);
                        const currentPrice = closes5m[closes5m.length - 1];

                        // Esegue il backtest geometrico storico sul livello di prezzo attuale
                        const backtest = await backtestPriceLevel(ohlcv15m, currentPrice, dynamicTakeProfit, Math.abs(dynamicStopLoss));
                        if (backtest.status === "PENALIZED") {
                            console.log(`[Risk Gate / Backtest] ${symbol} scartato: storico sfavorevole a questo livello di prezzo (WinRate stimato: ${backtest.winRate.toFixed(1)}%).`);
                            continue;
                        }

                        const { support } = findSupportAndResistance(ohlcv15m);
                        const { isGreenCandle } = detectChartPatterns(ohlcv5m);

                        let targetInvestmentSize = (isBtcBullish && !macro.isExtremeFear && !isPanicCrash) ? 12 : 5; 
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        if (!isGreenCandle) {
                            console.log(`[Diagnostica] ${symbol} saltato: nessuna conferma geometrica di candela verde a 5m.`);
                            continue;
                        }

                        const isWatchedOutperformer = watchedOutperformers.includes(symbol);
                        const nearSupport = support > 0 && (currentPrice <= support * 1.02);
                        const isOversold = (rsi5m < 34 || rsi15m < 38);
                        const strongMomentum = (rsi5m > 56 && rsi5m < 72 && rsi15m > 52);

                        let buyCondition = false;
                        let reason = "";

                        if (isWatchedOutperformer) {
                            buyCondition = (eurBalance >= 5);
                            reason = `Reingresso Outperformer (Backtest Storico OK - ${perf24h.toFixed(1)}% 24h)`;
                            watchedOutperformers = watchedOutperformers.filter(s => s !== symbol);
                        } else if (!isPanicCrash) {
                            if (strongMomentum || nearSupport || isOversold) {
                                buyCondition = (eurBalance >= 5);
                                reason = strongMomentum ? "Slancio Top Gainer (Backtest OK)" : "Supporto Confermato (Backtest OK)";
                            }
                        }

                        if (buyCondition) {
                            console.log(`[Risk Gate Passato] Acquistabile ${symbol} | Motivo: ${reason} | WinRate storico stimato: ${backtest.winRate.toFixed(1)}% | Prezzo: €${currentPrice}`);
                            const amountToBuy = targetInvestmentSize / currentPrice;
                            const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                            console.log(`[SUCCESSO ACQUISTO] Acquistati ~€${targetInvestmentSize} di ${symbol}! ID:`, order.id);
                            lastLog = `[${now}] Acquistati €${targetInvestmentSize} di ${symbol} (${reason})`;
                            await new Promise(resolve => setTimeout(resolve, 30000));
                            break;
                        }
                    } catch (altErr) {}
                }
            }
        } catch (err) {
            console.log("Errore nel ciclo principale:", err.message);
        }

        await new Promise(resolve => setTimeout(resolve, 180000));
    }
}

app.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
    runBotLoop();
});
