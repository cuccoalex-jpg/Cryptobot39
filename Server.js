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
let lastLog = "Bot avviato: Volumi Multi-Timeframe (4h/24h) + Anti-Stagnazione + Fast-Cut.";
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

// VALUTAZIONE TECNICA SUL 5M
function evaluateTechnicalScore(ohlcv) {
    if (!ohlcv || ohlcv.length < 20) return { score: 0, details: "Dati insufficienti" };

    const closes = ohlcv.map(c => c[4]);
    const lows = ohlcv.map(c => c[3]);
    const volumes = ohlcv.map(c => c[5]);
    
    const currentClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    const prevPrevClose = closes[closes.length - 3];
    
    let score = 0;
    let reasons = [];

    const rsi = calculateRSI(closes, 14);
    const isGreen = currentClose > prevClose;
    const isPrevGreen = prevClose > prevPrevClose;

    const recentLow = Math.min(...lows.slice(-12, -1));
    const bollinger = calculateBollingerBands(closes);

    if (currentClose <= recentLow * 1.012 || currentClose <= bollinger.middle * 1.008) {
        score += 3.0;
        reasons.push("Test / Supporto Raggiunto");
    }

    if (isGreen && isPrevGreen) {
        score += 2.5;
        reasons.push("Spinta Continua (2+ Candele)");
    } else if (isGreen) {
        score += 1.0;
        reasons.push("Reazione Verde");
    }

    if (rsi >= 45 && rsi <= 68) {
        score += 2.0;
        reasons.push(`RSI in Ripresa (${rsi.toFixed(1)})`);
    } else if (rsi > 68 && isGreen) {
        score += 1.0;
        reasons.push(`RSI Alto (${rsi.toFixed(1)})`);
    }

    const avgVolume = volumes.slice(-10, -1).reduce((a, b) => a + b, 0) / 9;
    const lastVolume = volumes[volumes.length - 1];
    if (lastVolume > avgVolume * 1.4 && isGreen) {
        score += 2.0;
        reasons.push("Volumi 5m Forti");
    }

    return { score, details: reasons.join(" + ") };
}

// FILTRO AGGIUNTIVO MULTI-TIMEFRAME (4h e 24h)
async function checkHigherTimeframeVolumes(symbol) {
    try {
        // Controllo candele 4h (ultime 6 candele = 24h di storico 4h)
        const ohlcv4h = await exchange.fetchOHLCV(symbol, '4h', undefined, 10);
        if (ohlcv4h && ohlcv4h.length >= 6) {
            const volumes4h = ohlcv4h.map(c => c[5]);
            const closes4h = ohlcv4h.map(c => c[4]);
            
            const last4hVolume = volumes4h[volumes4h.length - 1];
            const avg4hVolume = volumes4h.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
            
            const is4hGreen = closes4h[closes4h.length - 1] > closes4h[closes4h.length - 2];

            // Se il volume 4h è superiore alla media e la candela 4h è verde, c'è conferma solida
            if (last4hVolume >= avg4hVolume * 1.15 && is4hGreen) {
                return true;
            }
        }

        // Controllo candela 1d / 24h (se 4h non basta o come riscontro)
        const ohlcv1d = await exchange.fetchOHLCV(symbol, '1d', undefined, 5);
        if (ohlcv1d && ohlcv1d.length >= 3) {
            const closes1d = ohlcv1d.map(c => c[4]);
            const is1dGreen = closes1d[closes1d.length - 1] > closes1d[closes1d.length - 2];
            if (is1dGreen) return true;
        }

        return false;
    } catch (e) {
        // In caso di errore di fetch sui TF superiori, non blocchiamo l'operazione ma diamo via libera neutro
        return true;
    }
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

                // GESTIONE PORTAFOGLIO (TP, Fast-Cut e Time-Stop a 4 ore)
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

                            let entryPrice = currentPrice;
                            let entryTime = Date.now();

                            if (activePositions[symbol] && activePositions[symbol].entryPrice) {
                                entryPrice = activePositions[symbol].entryPrice;
                                if (activePositions[symbol].time) {
                                    entryTime = activePositions[symbol].time;
                                }
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
                            const isStagnant = (hoursOpen > 4 && profitPercentage > -0.18 && profitPercentage < 0.4);

                            console.log(`[Wallet] ${symbol} | Ingresso: €${entryPrice.toFixed(4)} | Attuale: €${currentPrice.toFixed(4)} | PnL: ${profitPercentage.toFixed(2)}% | Ore: ${hoursOpen.toFixed(1)}h`);

                            const freeCoinAmount = balance.free[rawCurrency] || balance.free[cleanCurrency] || balance.free[`X${cleanCurrency}`] || balance.free[`Z${cleanCurrency}`] || 0;
                            if (freeCoinAmount <= 0.0001) continue;

                            const isTpValid = profitPercentage >= targetTakeProfitLordo;
                            const isFastCutValid = profitPercentage <= thresholdFastCut;

                            if (isLiveFlashCrash || isTpValid || isFastCutValid || isStagnant) {
                                const reasonType = isLiveFlashCrash ? "FLASH CRASH" : (isTpValid ? "TAKE PROFIT" : (isFastCutValid ? "FAST CUT (-0.2%)" : "TIME-STOP / STAGNAZIONE"));
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
                    await new Promise(resolve => setTimeout(resolve, 1500));
                }

                if (isLiveFlashCrash) {
                    await new Promise(resolve => setTimeout(resolve, 30000));
                    continue;
                }

                // AGGIORNAMENTO HOT POOL
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

                // SCANSIONE WATCHLIST CON FILTRO 5M + CONFERMA VOLUMI 4H/24H
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

                            // 1. Analisi preliminare su timeframe 5m
                            const ohlcv5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 30);
                            const techEval = evaluateTechnicalScore(ohlcv5m);
                            
                            if (techEval.score < 4.5) continue; 

                            // 2. Conferma di volume e trend sui timeframe superiori (4h / 24h)
                            const isVolumeConfirmed = await checkHigherTimeframeVolumes(symbol);
                            if (!isVolumeConfirmed) {
                                console.log(`[Salta] ${symbol} ha superato il 5m ma manca la conferma di volume sui TF superiori (4h/24h).`);
                                continue;
                            }

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

                                console.log(`[BUY CONFERMATO 4H/24H - Score ${techEval.score}] Acquistati €${targetInvestmentSize} di ${symbol} a €${currentPrice.toFixed(4)} | Motivi: ${techEval.details}`);
                                lastLog = `Acquistati €${targetInvestmentSize} di ${symbol} (Score: ${techEval.score})`;
                                
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
