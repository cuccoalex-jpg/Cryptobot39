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
let lastLog = "Bot avviato: Memoria Locale Posizioni + Rimbalzo su Supporto + Fast-Cut -0.2%.";
let watchedOutperformers = [];
let focusedHotPool = [];
let lastHotPoolUpdate = 0;
global.lastBtcLivePrice = 0;

// REGISTRO LOCALE DELLE POSIZIONI APERTE DAL BOT (Evita le ricerche lente nello storico API)
let activePositions = {};

const stablecoinsToIgnore = ['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'ZEUR', 'KFEE', 'EUR', 'ZUSD'];

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Posizioni in Memoria Locale:</b> ${Object.keys(activePositions).length > 0 ? Object.keys(activePositions).join(', ') : 'Nessuna al momento'}</p>
                <p><b>Watchlist Attiva (A Lotti):</b> ${watchedOutperformers.length > 0 ? watchedOutperformers.join(', ') : 'Sincronizzazione in corso...'}</p>
            </body>
        </html>
    `);
});

app.post('/api/toggle', (req, res) => {
    botRunning = !botRunning;
    lastLog = `Bot ${botRunning ? 'riattivato' : 'messo in pausa'} via API.`;
    res.json({ success: true, botRunning, message: lastLog });
});

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

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
    const bandWidth = (upper - lower) / middle;
    const isSideways = bandWidth < 0.04;

    return { upper, middle, lower, isSideways };
}

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

    const recentLow = Math.min(...lows.slice(-12, -1));
    const bollinger = calculateBollingerBands(closes);

    if (currentClose <= recentLow * 1.012 || currentClose <= bollinger.middle * 1.008) {
        score += 3.5;
        reasons.push("Test / Supporto Raggiunto");
    }

    if (isGreen) {
        score += 2.5;
        reasons.push("Reazione Verde di Rimbalzo");
    }

    if (rsi >= 45 && rsi <= 68) {
        score += 2;
        reasons.push(`Trend / RSI in Ripresa (${rsi.toFixed(1)})`);
    } else if (rsi > 68 && isGreen) {
        score += 1.5;
        reasons.push(`Spinta Alta (RSI: ${rsi.toFixed(1)})`);
    }

    const avgVolume = volumes.slice(-10, -1).reduce((a, b) => a + b, 0) / 9;
    const lastVolume = volumes[volumes.length - 1];
    if (lastVolume > avgVolume * 1.2 && isGreen) {
        score += 2;
        reasons.push("Volumi in Ingresso sul Supporto");
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

                let isBtcBullish = false;
                try {
                    const btcOhlcv1h = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 20);
                    const btcCloses1h = btcOhlcv1h.map(c => c[4]);
                    const btcPrice = btcCloses1h[btcCloses1h.length - 1];
                    const btcOpen1h = btcOhlcv1h[btcOhlcv1h.length - 1][1];
                    const btcChange1h = ((btcPrice - btcOpen1h) / btcOpen1h) * 100;

                    const btcOhlcv4h = await exchange.fetchOHLCV('BTC/EUR', '4h', undefined, 10);
                    const btcCloses4h = btcOhlcv4h.map(c => c[4]);
                    const btcOpen4h = btcOhlcv4h[btcOhlcv4h.length - 1][1];
                    const btcChange4h = ((btcPrice - btcOpen4h) / btcOpen4h) * 100;

                    isBtcBullish = (btcChange1h > 0.2 && btcChange4h >= -0.2 && !isLiveFlashCrash);
                } catch (btcErr) {
                    isBtcBullish = false;
                }

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

                const portfolioBatchSize = 3;
                for (let i = 0; i < assetKeys.length; i += portfolioBatchSize) {
                    const batch = assetKeys.slice(i, i + portfolioBatchSize);
                    
                    for (const rawCurrency of batch) {
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

                            // RECUPERO PREZZO DI CARICO DA MEMORIA LOCALE O FALLBACK IMMEDIATO
                            let entryPrice = currentPrice;
                            if (activePositions[symbol] && activePositions[symbol].entryPrice) {
                                entryPrice = activePositions[symbol].entryPrice;
                            } else {
                                // Se non è in memoria (es. asset vecchio), proviamo a leggerlo una sola volta o usiamo il prezzo attuale per evitare blocchi
                                activePositions[symbol] = { entryPrice: currentPrice };
                            }

                            const profitPercentage = ((currentPrice - entryPrice) / entryPrice) * 100;
                            console.log(`[Wallet] ${symbol} | Ingresso: €${entryPrice.toFixed(2)} | Attuale: €${currentPrice.toFixed(2)} | PnL: ${profitPercentage.toFixed(2)}%`);

                            const freeCoinAmount = balance.free[rawCurrency] || balance.free[cleanCurrency] || balance.free[`X${cleanCurrency}`] || balance.free[`Z${cleanCurrency}`] || 0;
                            if (freeCoinAmount <= 0.0001) continue;

                            const isTpValid = profitPercentage >= targetTakeProfitLordo;
                            const isFastCutValid = profitPercentage <= thresholdFastCut;

                            if (isLiveFlashCrash || isTpValid || isFastCutValid) {
                                const reasonType = isLiveFlashCrash ? "FLASH CRASH" : (isTpValid ? "TAKE PROFIT" : "FAST CUT (-0.2%)");
                                console.log(`[VENDITA] Chiusura (${reasonType}) su ${symbol} (PnL: ${profitPercentage.toFixed(2)}%). Invio ordine...`);

                                const sellRes = await exchange.createMarketSellOrder(symbol, freeCoinAmount);
                                console.log(`[VENDITA OK] Posizione ${symbol} chiusa! ID:`, sellRes.id);
                                lastLog = `Chiuso ${symbol} (${reasonType}) - PnL: ${profitPercentage.toFixed(2)}%`;
                                
                                // Rimuoviamo la posizione dalla memoria locale dopo la vendita
                                delete activePositions[symbol];

                                await new Promise(resolve => setTimeout(resolve, 3000));
                            }
                        } catch (errPort) {
                            console.log(`Errore asset ${symbol}:`, errPort.message);
                        }
                    }
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }

                if (isLiveFlashCrash) {
                    await new Promise(resolve => setTimeout(resolve, 30000));
                    continue;
                }

                const currentTime = Date.now();
                if (focusedHotPool.length === 0 || (currentTime - lastHotPoolUpdate > 15 * 60 * 1000)) {
                    let krakenPairs = Object.keys(exchange.markets).filter(symbol => {
                        if (!symbol.endsWith('/EUR') || !exchange.markets[symbol].active) return false;
                        const base = symbol.split('/')[0].replace(/^[XZ]/, '');
                        return !stablecoinsToIgnore.includes(base);
                    });

                    let cmcTopMovers = [];
                    if (CMC_API_KEY) {
                        try {
                            const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                                headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                                params: { start: 1, limit: 100, sort: 'percent_change_24h', sort_dir: 'desc', convert: 'EUR' }
                            });
                            for (const coin of cmcResponse.data.data) {
                                const baseSym = coin.symbol;
                                if (stablecoinsToIgnore.includes(baseSym)) continue;
                                const sym = `${baseSym}/EUR`;
                                if (exchange.markets[sym] && exchange.markets[sym].active) {
                                    cmcTopMovers.push(sym);
                                }
                            }
                        } catch (e) {}
                    }

                    focusedHotPool = [...new Set([...cmcTopMovers, ...shuffleArray(krakenPairs)])].slice(0, 37);
                    watchedOutperformers = focusedHotPool.slice(0, 10);
                    lastHotPoolUpdate = currentTime;
                }

                const watchlistBatchSize = 5;
                for (let i = 0; i < focusedHotPool.length; i += watchlistBatchSize) {
                    const batchSymbols = focusedHotPool.slice(i, i + watchlistBatchSize);
                    let boughtInThisCycle = false;

                    for (const symbol of batchSymbols) {
                        try {
                            if (!exchange.markets[symbol]) continue;
                            
                            const baseCurrency = symbol.split('/')[0];
                            if (balance.total[baseCurrency] && balance.total[baseCurrency] > 0.0001) continue; 
                            const rawKey = Object.keys(balance.total).find(k => k.includes(baseCurrency));
                            if (rawKey && balance.total[rawKey] > 0.0001) continue;

                            const ohlcv5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 30);
                            const techEval = evaluateTechnicalScore(ohlcv5m);
                            
                            if (techEval.score < 4.0) continue; 

                            let targetInvestmentSize = 5; 
                            if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                            if (eurBalance >= 5) {
                                const currentPrice = ohlcv5m[ohlcv5m.length - 1][4];
                                const amountToBuy = targetInvestmentSize / currentPrice;
                                const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                                
                                // SALVIAMO SUBITO IN MEMORIA LOCALE IL PREZZO DI ACQUISTO
                                activePositions[symbol] = {
                                    entryPrice: currentPrice,
                                    amount: amountToBuy,
                                    time: Date.now()
                                };

                                console.log(`[BUY SUPPORT BOUNCE SCORE ${techEval.score}] Acquistati €${targetInvestmentSize} di ${symbol} al prezzo di €${currentPrice.toFixed(4)} | Motivi: ${techEval.details}!`);
                                lastLog = `Acquistati €${targetInvestmentSize} di ${symbol} (Bounce Score: ${techEval.score})`;
                                
                                boughtInThisCycle = true;
                                await new Promise(resolve => setTimeout(resolve, 5000));
                                break;
                            }
                        } catch (altErr) {}
                    }

                    if (boughtInThisCycle) break;
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        } catch (err) {
            console.log("Errore nel ciclo principale:", err.message);
        }

        await new Promise(resolve => setTimeout(resolve, 60000));
    }
}

app.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
    setTimeout(() => {
        runBotLoop();
    }, 3000);
});
