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
let lastLog = "Bot avviato: Focalizzato sui Top Movers di Giornata + Anti-Stagnazione.";
let watchedOutperformers = [];
let focusedHotPool = [];
let lastHotPoolUpdate = 0;
global.lastBtcLivePrice = 0;

let activePositions = {};

const stablecoinsToIgnore = ['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'ZEUR', 'KFEE', 'EUR', 'ZUSD'];

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Posizioni in Memoria Locale:</b> ${Object.keys(activePositions).length > 0 ? Object.keys(activePositions).join(', ') : 'Nessuna'}</p>
                <p><b>Top Movers Monitorati (Focus Stretto):</b> ${focusedHotPool.length > 0 ? focusedHotPool.join(', ') : 'Sincronizzazione in corso...'}</p>
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

function calculateBollingerBands(closes, period = 20, stdDevMultiplier = 2) {
    if (!closes || closes.length < period) return { upper: 0, middle: 0, lower: 0, isSideways: false };
    const slice = closes.slice(-period);
    const middle = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    const upper = middle + (stdDevMultiplier * stdDev);
    const lower = middle - (stdDevMultiplier * stdDev);
    return { upper, middle, lower };
}

// VALUTAZIONE TECNICA MIRATA SUL MOMENTUM DEI TOP MOVERS
function evaluateTechnicalScore(ohlcv) {
    if (!ohlcv || ohlcv.length < 20) return { score: 0, details: "Dati insufficienti" };

    const closes = ohlcv.map(c => c[4]);
    const lows = ohlcv.map(c => c[3]);
    const volumes = ohlcv.map(c => c[5]);
    
    const currentClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    
    let score = 0;
    let reasons = [];

    const rsi = calculateRSI(closes, 14);
    const isGreen = currentClose > prevClose;

    // Se è un top mover, cerchiamo il piccolo pull-back o la ripartenza immediata
    const recentLow = Math.min(...lows.slice(-8, -1));
    if (currentClose <= recentLow * 1.015 || isGreen) {
        score += 3.0;
        reasons.push("Spinta / Reazione su Top Mover");
    }

    if (rsi >= 45 && rsi <= 75) {
        score += 2.5;
        reasons.push(`RSI Dinamico (${rsi.toFixed(1)})`);
    }

    const avgVolume = volumes.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
    const lastVolume = volumes[volumes.length - 1];
    if (lastVolume > avgVolume * 1.2 && isGreen) {
        score += 2.5;
        reasons.push("Volumi in Continuazione");
    }

    return { score, details: reasons.join(" + ") };
}

async function runBotLoop() {
    while (true) {
        try {
            if (botRunning) {
                const now = new Date().toLocaleString();
                await exchange.loadMarkets();

                const balance = await exchange.fetchBalance();
                const eurBalance = balance.free['EUR'] || balance.free['ZEUR'] || 0;
                console.log(`[${now}] Saldo EUR: €${eurBalance.toFixed(2)}`);

                let isLiveFlashCrash = false;
                try {
                    const btcTicker = await exchange.fetchTicker('BTC/EUR');
                    const btcCurrentLivePrice = btcTicker.last;
                    if (global.lastBtcLivePrice && btcCurrentLivePrice < global.lastBtcLivePrice * 0.985) {
                        console.log(`[FLASH CRASH] BTC a €${btcCurrentLivePrice}! Protezione attiva.`);
                        isLiveFlashCrash = true;
                    }
                    global.lastBtcLivePrice = btcCurrentLivePrice;
                } catch (e) {}

                const targetTakeProfitLordo = 1.12; 
                const thresholdFastCut = -0.2; 

                const totalBalances = balance.total || {};
                const assetKeys = Object.keys(totalBalances).filter(rawCurrency => {
                    if (stablecoinsToIgnore.includes(rawCurrency)) return false;
                    const amt = totalBalances[rawCurrency] || 0;
                    if (amt <= 0.0001) return false;
                    let clean = rawCurrency.replace(/^[XZ]/, '');
                    if (clean === 'XBT') clean = 'BTC';
                    return !stablecoinsToIgnore.includes(clean);
                });

                // 1. GESTIONE PORTAFOGLIO (TP, Fast-Cut e Time-Stop ridotto a 2.5 ore per i Top Movers)
                for (const rawCurrency of assetKeys) {
                    let cleanCurrency = rawCurrency.replace(/^[XZ]/, '');
                    if (cleanCurrency === 'XBT') cleanCurrency = 'BTC';

                    let symbol = `${cleanCurrency}/EUR`;
                    if (!exchange.markets[symbol]) {
                        symbol = `${rawCurrency}/EUR`;
                        if (!exchange.markets[symbol]) continue;
                    }

                    try {
                        const ticker = await exchange.fetchTicker(symbol);
                        const currentPrice = ticker.last;

                        let entryPrice = currentPrice;
                        let entryTime = Date.now();

                        if (activePositions[symbol] && activePositions[symbol].entryPrice) {
                            entryPrice = activePositions[symbol].entryPrice;
                            if (activePositions[symbol].time) entryTime = activePositions[symbol].time;
                        } else {
                            try {
                                const myTrades = await exchange.fetchMyTrades(symbol, undefined, 10);
                                const lastBuy = myTrades.reverse().find(t => t.side === 'buy');
                                if (lastBuy && lastBuy.price) {
                                    entryPrice = lastBuy.price;
                                    entryTime = lastBuy.timestamp || Date.now();
                                    activePositions[symbol] = { entryPrice: entryPrice, time: entryTime };
                                } else {
                                    activePositions[symbol] = { entryPrice: currentPrice, time: Date.now() };
                                }
                            } catch (e) {
                                activePositions[symbol] = { entryPrice: currentPrice, time: Date.now() };
                            }
                        }

                        const profitPercentage = ((currentPrice - entryPrice) / entryPrice) * 100;
                        const hoursOpen = (Date.now() - entryTime) / (1000 * 60 * 60);
                        // Time-Stop più stretto a 2.5 ore: se un top mover non spinge subito, usciamo e ruotiamo il capitale
                        const isStagnant = (hoursOpen > 2.5 && profitPercentage > -0.15 && profitPercentage < 0.3);

                        console.log(`[Wallet] ${symbol} | Ingresso: €${entryPrice.toFixed(4)} | Attuale: €${currentPrice.toFixed(4)} | PnL: ${profitPercentage.toFixed(2)}% | Ore: ${hoursOpen.toFixed(1)}h`);

                        const freeCoinAmount = balance.free[rawCurrency] || balance.free[cleanCurrency] || balance.free[`X${cleanCurrency}`] || balance.free[`Z${cleanCurrency}`] || 0;
                        if (freeCoinAmount <= 0.0001) continue;

                        const isTpValid = profitPercentage >= targetTakeProfitLordo;
                        const isFastCutValid = profitPercentage <= thresholdFastCut;

                        if (isLiveFlashCrash || isTpValid || isFastCutValid || isStagnant) {
                            const reasonType = isLiveFlashCrash ? "FLASH CRASH" : (isTpValid ? "TAKE PROFIT" : (isFastCutValid ? "FAST CUT (-0.2%)" : "TIME-STOP RAPIDO"));
                            console.log(`[VENDITA] Chiusura (${reasonType}) su ${symbol} (PnL: ${profitPercentage.toFixed(2)}%). Invio ordine...`);

                            const sellRes = await exchange.createMarketSellOrder(symbol, freeCoinAmount);
                            console.log(`[VENDITA OK] Posizione ${symbol} chiusa! ID:`, sellRes.id);
                            lastLog = `Chiuso ${symbol} (${reasonType}) - PnL: ${profitPercentage.toFixed(2)}%`;
                            
                            delete activePositions[symbol];
                            await new Promise(resolve => setTimeout(resolve, 3000));
                        }
                    } catch (errPort) {
                        console.log(`Errore asset ${symbol}:`, errPort.message);
                    }
                }

                if (isLiveFlashCrash) {
                    await new Promise(resolve => setTimeout(resolve, 30000));
                    continue;
                }

                // 2. SELEZIONE RISTRETTA DEI TOP 5 MOVERS DI GIORNATA
                const currentTime = Date.now();
                if (focusedHotPool.length === 0 || (currentTime - lastHotPoolUpdate > 10 * 60 * 1000)) {
                    let topMoversList = [];
                    if (CMC_API_KEY) {
                        try {
                            const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                                headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                                params: { start: 1, limit: 80, sort: 'percent_change_24h', sort_dir: 'desc', convert: 'EUR' }
                            });
                            for (const coin of cmcResponse.data.data) {
                                const baseSym = coin.symbol;
                                if (stablecoinsToIgnore.includes(baseSym)) continue;
                                const sym = `${baseSym}/EUR`;
                                if (exchange.markets[sym] && exchange.markets[sym].active) {
                                    topMoversList.push(sym);
                                }
                            }
                        } catch (e) {}
                    }

                    // Se CMC non risponde o per fallback, prendiamo i ticker da Kraken e filtriamo per variazione 24h
                    if (topMoversList.length === 0) {
                        let krakenTickers = await exchange.fetchTickers();
                        let sortedKraken = Object.keys(krakenTickers)
                            .filter(s => s.endsWith('/EUR') && !stablecoinsToIgnore.includes(s.split('/')[0].replace(/^[XZ]/, '')))
                            .sort((a, b) => (krakenTickers[b].percentage || 0) - (krakenTickers[a].percentage || 0));
                        topMoversList = sortedKraken;
                    }

                    // RESTRINGIAMO IL FOCUS SOLO AI TOP 5 ABSOLUTI DELLA GIORNATA
                    focusedHotPool = topMoversList.slice(0, 5);
                    watchedOutperformers = focusedHotPool;
                    lastHotPoolUpdate = currentTime;
                    console.log(`[Focus] Nuova watchlist Top Movers stretta: ${focusedHotPool.join(', ')}`);
                }

                // 3. SCANNER RAPIDO SU QUESTI 5 SPECIALISTI
                for (const symbol of focusedHotPool) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        
                        const baseCurrency = symbol.split('/')[0];
                        if (balance.total[baseCurrency] && balance.total[baseCurrency] > 0.0001) continue; 
                        const rawKey = Object.keys(balance.total).find(k => k.includes(baseCurrency));
                        if (rawKey && balance.total[rawKey] > 0.0001) continue;

                        const ohlcv5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 20);
                        const techEval = evaluateTechnicalScore(ohlcv5m);
                        
                        if (techEval.score < 4.0) continue; 

                        let targetInvestmentSize = 5; 
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        if (eurBalance >= 5) {
                            const currentPrice = ohlcv5m[ohlcv5m.length - 1][4];
                            const amountToBuy = targetInvestmentSize / currentPrice;
                            const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                            
                            activePositions[symbol] = {
                                entryPrice: currentPrice,
                                amount: amountToBuy,
                                time: Date.now()
                            };

                            console.log(`[TOP MOVER BUY - Score ${techEval.score}] Acquistati €${targetInvestmentSize} di ${symbol} a €${currentPrice.toFixed(4)} | Motivi: ${techEval.details}`);
                            lastLog = `Acquistati €${targetInvestmentSize} di ${symbol} (Top Mover)`;
                            
                            await new Promise(resolve => setTimeout(resolve, 5000));
                            break;
                        }
                    } catch (altErr) {}
                }
            }
        } catch (err) {
            console.log("Errore nel ciclo principale:", err.message);
        }

        await new Promise(resolve => setTimeout(resolve, 30000)); // Ciclo più reattivo ogni 30 secondi
    }
}

app.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
    setTimeout(() => {
        runBotLoop();
    }, 3000);
});
