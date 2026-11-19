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
let lastLog = "Bot avviato: Termometro BTC Severo + Rimbalzi 5m + Take Profit Dinamico (10€).";
let focusedHotPool = [];
let dailyWinnersSet = new Set();
let lastHotPoolUpdate = 0;
global.lastBtcLivePrice = 0;

let activePositions = {};
let btcLockedUntil = 0;

const stablecoinsToIgnore = ['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'ZEUR', 'KFEE', 'EUR', 'ZUSD'];

// Watchlist richiesta (senza ETH; Cronos -> CRO; coppie non attive su Kraken vengono scartate in automatico)
const customWatchlistSymbols = [
    'PEPE/EUR', 'SUI/EUR', 'SKI/EUR', 'SOL/EUR', 'HYPE/EUR',
    'AAVE/EUR', 'ALLO/EUR', 'WLD/EUR', 'NEAR/EUR', 'SEI/EUR',
    'LINK/EUR', 'GM/EUR', 'CRO/EUR', 'MNT/EUR', 'GRT/EUR',
    'UNI/EUR', 'ENA/EUR'
];

// Parametri Rimbalzi Brevi (5m) + Take Profit Dinamico + Trailing Stop + 6 Candele (30 min)
const ORDER_SIZE_EUR = 10;
const TIMEFRAME_ENTRY = '5m';
const MAX_CANDLES_WINDOW = 6;                 // 6 candele su 5m = 30 minuti
const MAX_HOLD_MINUTES = 30;
const ESTIMATED_ROUNDTRIP_FEE_PCT = 0.50;     // Fee andata/ritorno + spread stimate
const BASE_TP_NET_PCT = 0.75;                 // ~1.25% lordo Take Profit base
const EXTENDED_V_TP_NET_PCT = 1.45;           // ~1.95% lordo Take Profit esteso su V ampia e mercato sano
const TRAILING_ARM_GROSS_PCT = 0.85;          // Sopra +0.85% lordo arma il trailing stop
const TRAILING_FLOOR_GROSS_PCT = 0.25;        // Protezione minima sopra le fee una volta armato
const TRAILING_PULLBACK_PCT = 0.45;           // Chiude se scende di 0.45% dal picco raggiunto
const STOP_LOSS_FAST_CUT_PCT = -1.0;          // Fast-cut / stop loss

// Termometro BTC SEVERO (anti-crollo + isteresi lunga)
const BTC_FLASH_CRASH_DROP_RATIO = 0.990;     // -1.0% tra due letture live
const BTC_MAX_DROP_1H_PERCENT = -0.5;        // Blocca se BTC scende oltre -0.5% nell'ultima ora
const BTC_MAX_DROP_3H_PERCENT = -1.0;        // Blocca se BTC scende oltre -1.0% in 3 ore
const BTC_MAX_DROP_15M_4C_PERCENT = -0.6;    // Blocca se BTC scende oltre -0.6% nelle ultime 4 candele da 15m (1h)
const BTC_LOCK_DURATION_MS = 20 * 60 * 1000;  // Mantiene il blocco almeno 20 minuti quando scatta
const MIN_ENTRY_SCORE_5M = 6.0;

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Posizioni in Memoria Locale:</b> ${Object.keys(activePositions).length > 0 ? Object.keys(activePositions).join(', ') : 'Nessuna'}</p>
                <p><b>Watchlist Attiva (5m):</b> ${focusedHotPool.length > 0 ? focusedHotPool.join(', ') : 'Sincronizzazione in corso...'}</p>
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
    if (!closes || closes.length < period) return { upper: 0, middle: 0, lower: 0 };
    const slice = closes.slice(-period);
    const middle = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - middle, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    const upper = middle + (stdDevMultiplier * stdDev);
    const lower = middle - (stdDevMultiplier * stdDev);
    return { upper, middle, lower };
}

// FILTRO NOTIZIE E SENTIMENT GLOBALE TRAMITE COINMARKETCAP
async function checkLiveNewsAndSentiment() {
    try {
        if (CMC_API_KEY) {
            const globalRes = await axios.get('https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest', {
                headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY }
            });
            const marketCapChange = globalRes.data.data.quote.EUR.total_market_cap_yesterday_percentage_change;
            if (marketCapChange < -2.5) {
                return { safeMode: true, reason: `Sentiment Globale Negativo / News Macro (${marketCapChange.toFixed(2)}%)` };
            }
        }
        return { safeMode: false };
    } catch (e) {
        return { safeMode: false };
    }
}

// TERMOMETRO BTC SEVERO CON ISTERESI LUNGA
async function evaluateBtcThermometer() {
    let isLiveFlashCrash = false;
    let isBtcHealthy = true;
    let btcChange1h = 0;
    let btcChange3h = 0;
    let btcChange15m4c = 0;
    let blockReason = "";

    try {
        const btcTicker = await exchange.fetchTicker('BTC/EUR');
        const btcCurrentLivePrice = btcTicker.last;
        if (global.lastBtcLivePrice && btcCurrentLivePrice < global.lastBtcLivePrice * BTC_FLASH_CRASH_DROP_RATIO) {
            console.log(`[FLASH CRASH] BTC a €${btcCurrentLivePrice}! Sospensione totale.`);
            isLiveFlashCrash = true;
            btcLockedUntil = Date.now() + BTC_LOCK_DURATION_MS;
            blockReason = "Flash Crash live";
        }
        global.lastBtcLivePrice = btcCurrentLivePrice;
    } catch (e) {}

    let isStillDropping = false;

    try {
        const btcOhlcv1h = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 5);
        if (btcOhlcv1h && btcOhlcv1h.length >= 4) {
            const lastCandle = btcOhlcv1h[btcOhlcv1h.length - 1];
            const prevCandle = btcOhlcv1h[btcOhlcv1h.length - 2];
            const candle3hAgo = btcOhlcv1h[btcOhlcv1h.length - 4];

            btcChange1h = ((lastCandle[4] - lastCandle[1]) / lastCandle[1]) * 100;
            btcChange3h = ((lastCandle[4] - candle3hAgo[1]) / candle3hAgo[1]) * 100;

            // Qualsiasi candela 1h che chiude sotto la precedente con calo > -0.25% è considerata debolezza attiva
            isStillDropping = (lastCandle[4] < prevCandle[4]) && (btcChange1h < -0.25);

            if (btcChange1h < BTC_MAX_DROP_1H_PERCENT) {
                btcLockedUntil = Date.now() + BTC_LOCK_DURATION_MS;
                blockReason = `Calo 1h ${btcChange1h.toFixed(2)}% < ${BTC_MAX_DROP_1H_PERCENT}%`;
            } else if (btcChange3h < BTC_MAX_DROP_3H_PERCENT) {
                btcLockedUntil = Date.now() + BTC_LOCK_DURATION_MS;
                blockReason = `Calo 3h ${btcChange3h.toFixed(2)}% < ${BTC_MAX_DROP_3H_PERCENT}%`;
            } else if (isStillDropping) {
                btcLockedUntil = Date.now() + BTC_LOCK_DURATION_MS;
                blockReason = `BTC in discesa su 1h (${btcChange1h.toFixed(2)}%)`;
            }
        }
    } catch (btcErr) {}

    try {
        const btcOhlcv15m = await exchange.fetchOHLCV('BTC/EUR', '15m', undefined, 6);
        if (btcOhlcv15m && btcOhlcv15m.length >= 5) {
            const recent15m = btcOhlcv15m[btcOhlcv15m.length - 1];
            const fourCandlesAgo15m = btcOhlcv15m[btcOhlcv15m.length - 5];
            btcChange15m4c = ((recent15m[4] - fourCandlesAgo15m[1]) / fourCandlesAgo15m[1]) * 100;
            if (btcChange15m4c < BTC_MAX_DROP_15M_4C_PERCENT) {
                btcLockedUntil = Date.now() + BTC_LOCK_DURATION_MS;
                blockReason = blockReason || `Calo 15m (4 candele) ${btcChange15m4c.toFixed(2)}% < ${BTC_MAX_DROP_15M_4C_PERCENT}%`;
            }
        }
    } catch (e15) {}

    // Mantiene il blocco finché scade il lock AND BTC ha recuperato chiaramente (sopra -0.2% su 1h e senza discesa in corso)
    if (isLiveFlashCrash) {
        isBtcHealthy = false;
        blockReason = blockReason || "Flash Crash live";
    } else if (Date.now() < btcLockedUntil || btcChange1h < BTC_MAX_DROP_1H_PERCENT || btcChange3h < BTC_MAX_DROP_3H_PERCENT || btcChange15m4c < BTC_MAX_DROP_15M_4C_PERCENT || isStillDropping) {
        if (Date.now() >= btcLockedUntil && btcChange1h > -0.20 && btcChange3h > -0.60 && btcChange15m4c > -0.25 && !isStillDropping) {
            btcLockedUntil = 0;
            isBtcHealthy = true;
        } else {
            isBtcHealthy = false;
            const remainingMin = Math.max(0, Math.ceil((btcLockedUntil - Date.now()) / 60000));
            if (!blockReason) {
                blockReason = `Blocco severo BTC attivo (ancora ~${remainingMin}m, 1h ${btcChange1h.toFixed(2)}%)`;
            }
        }
    }

    return { isLiveFlashCrash, isBtcHealthy, btcChange1h, btcChange3h, btcChange15m4c, blockReason };
}

// VALUTA STRUTTURA A V E CALCOLA TAKE PROFIT DINAMICO
function evaluateVStructureAndTp(ohlcv5m, isBtcHealthy, isDailyWinner) {
    let vDepthPct = 0;
    let vReboundPct = 0;
    let isVShape = false;
    let vExhausted = false;

    if (ohlcv5m && ohlcv5m.length >= 12) {
        const highs = ohlcv5m.map(c => c[2]);
        const lows = ohlcv5m.map(c => c[3]);
        const closes = ohlcv5m.map(c => c[4]);
        const volumes = ohlcv5m.map(c => c[5]);

        const lookbackLows = lows.slice(-10, -1);
        const minIdxRel = lookbackLows.reduce((bestIdx, val, idx, arr) => val < arr[bestIdx] ? idx : bestIdx, 0);
        const vBottom = lookbackLows[minIdxRel];

        const preDropHighs = highs.slice(0, Math.max(2, highs.length - 10 + minIdxRel));
        const peakBeforeDrop = preDropHighs.length > 0 ? Math.max(...preDropHighs) : closes[closes.length - 1];

        const currentClose = closes[closes.length - 1];
        const prevClose = closes[closes.length - 2];

        vDepthPct = peakBeforeDrop > 0 ? ((peakBeforeDrop - vBottom) / peakBeforeDrop) * 100 : 0;
        vReboundPct = vBottom > 0 ? ((currentClose - vBottom) / vBottom) * 100 : 0;

        isVShape = (vDepthPct >= 0.9) && (vReboundPct >= 0.6) && (currentClose > vBottom);

        const avgVol = volumes.slice(-6, -1).reduce((a, b) => a + b, 0) / 5;
        const lastVol = volumes[volumes.length - 1];
        const isRedCandle = currentClose < prevClose;
        const nearPriorHigh = peakBeforeDrop > 0 && currentClose >= peakBeforeDrop * 0.996;
        vExhausted = isVShape && ((isRedCandle && lastVol < avgVol * 0.9) || (nearPriorHigh && isRedCandle));
    }

    let targetNet = BASE_TP_NET_PCT;
    if (isBtcHealthy && isVShape && vDepthPct >= 1.3 && (vReboundPct >= 1.0 || isDailyWinner)) {
        targetNet = EXTENDED_V_TP_NET_PCT;
    }

    const dynamicTpGrossPct = Number((targetNet + ESTIMATED_ROUNDTRIP_FEE_PCT).toFixed(2));
    return { isVShape, vDepthPct, vReboundPct, vExhausted, dynamicTpGrossPct };
}

// VALUTAZIONE TECNICA SU 5M PER RIMBALZI VELOCI
function evaluateTechnicalScore5m(ohlcv, isDailyWinnerOversold = false) {
    if (!ohlcv || ohlcv.length < 22) return { score: 0, details: "Dati insufficienti" };

    const closes = ohlcv.map(c => c[4]);
    const opens = ohlcv.map(c => c[1]);
    const lows = ohlcv.map(c => c[3]);
    const volumes = ohlcv.map(c => c[5]);

    const currentClose = closes[closes.length - 1];
    const currentOpen = opens[opens.length - 1];
    const prevClose = closes[closes.length - 2];
    const prevLow = lows[lows.length - 2];

    let score = 0;
    let reasons = [];

    const rsi = calculateRSI(closes, 14);
    const prevRsi = calculateRSI(closes.slice(0, -1), 14);
    const bollinger = calculateBollingerBands(closes);

    const isGreenReaction = (currentClose > prevClose) && (currentClose >= currentOpen);
    const recentLow = Math.min(...lows.slice(-10, -2));
    const testedSupportAndReacted = (prevLow <= recentLow * 1.006) && isGreenReaction;
    const lowerBollingerReaction = (prevLow <= bollinger.lower * 1.006) && isGreenReaction;

    if (testedSupportAndReacted || lowerBollingerReaction) {
        score += 3.5;
        reasons.push("Rimbalzo 5m su Supporto/Bollinger");
    } else {
        score -= 2.0;
    }

    if (isDailyWinnerOversold && rsi <= 46 && rsi > prevRsi && isGreenReaction) {
        score += 2.5;
        reasons.push(`Vincenti Giornata in Rimbalzo 5m (RSI ${prevRsi.toFixed(1)} -> ${rsi.toFixed(1)})`);
    } else if (rsi >= 32 && rsi <= 62 && rsi > prevRsi + 0.8) {
        score += 2.0;
        reasons.push(`RSI 5m in Risalita (${prevRsi.toFixed(1)} -> ${rsi.toFixed(1)})`);
    }

    const avgVolume = volumes.slice(-7, -1).reduce((a, b) => a + b, 0) / 6;
    const lastVolume = volumes[volumes.length - 1];

    if (lastVolume > avgVolume * 1.25 && isGreenReaction) {
        score += 2.5;
        reasons.push("Volumi 5m in Spinta");
    } else if (lastVolume < avgVolume * 0.85) {
        score -= 1.5;
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

                // 0. CONTROLLO NOTIZIE E SENTIMENT MACRO GLOBALE
                const newsCheck = await checkLiveNewsAndSentiment();
                if (newsCheck.safeMode) {
                    console.log(`[NEWS / SENTIMENT ALERT] ${newsCheck.reason}. Bot in pausa protettiva.`);
                    await new Promise(resolve => setTimeout(resolve, 30000));
                    continue;
                }

                // 1. TERMOMETRO BTC SEVERO
                const btcThermometer = await evaluateBtcThermometer();
                const { isLiveFlashCrash, isBtcHealthy, btcChange1h, btcChange3h, btcChange15m4c, blockReason } = btcThermometer;

                const totalBalances = balance.total || {};
                const assetKeys = Object.keys(totalBalances).filter(rawCurrency => {
                    if (stablecoinsToIgnore.includes(rawCurrency)) return false;
                    const amt = totalBalances[rawCurrency] || 0;
                    if (amt <= 0.0001) return false;
                    let clean = rawCurrency.replace(/^[XZ]/, '');
                    if (clean === 'XBT') clean = 'BTC';
                    return !stablecoinsToIgnore.includes(clean);
                });

                // 2. GESTIONE PORTAFOGLIO (Take Profit Dinamico + Trailing Stop + Uscita V + 6 Candele / 30m)
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
                        let peakProfitPct = 0;

                        if (activePositions[symbol] && activePositions[symbol].entryPrice) {
                            entryPrice = activePositions[symbol].entryPrice;
                            entryTime = activePositions[symbol].time || Date.now();
                            peakProfitPct = activePositions[symbol].peakProfitPct || 0;
                        } else {
                            try {
                                const myTrades = await exchange.fetchMyTrades(symbol, undefined, 10);
                                const lastBuy = myTrades.reverse().find(t => t.side === 'buy');
                                if (lastBuy && lastBuy.price) {
                                    entryPrice = lastBuy.price;
                                    entryTime = lastBuy.timestamp || Date.now();
                                }
                            } catch (e) {}
                            activePositions[symbol] = { entryPrice, time: entryTime, peakProfitPct: 0 };
                        }

                        const profitPercentage = ((currentPrice - entryPrice) / entryPrice) * 100;
                        if (profitPercentage > peakProfitPct) {
                            peakProfitPct = profitPercentage;
                            activePositions[symbol].peakProfitPct = peakProfitPct;
                        }

                        const minutesOpen = (Date.now() - entryTime) / (1000 * 60);
                        const candlesElapsed = Math.floor(minutesOpen / 5);

                        let vInfo = { isVShape: false, vExhausted: false, dynamicTpGrossPct: Number((BASE_TP_NET_PCT + ESTIMATED_ROUNDTRIP_FEE_PCT).toFixed(2)) };
                        try {
                            const posOhlcv = await exchange.fetchOHLCV(symbol, TIMEFRAME_ENTRY, undefined, 15);
                            vInfo = evaluateVStructureAndTp(posOhlcv, isBtcHealthy, dailyWinnersSet.has(symbol));
                        } catch (e) {}

                        let isTrailingHit = false;
                        if (peakProfitPct >= TRAILING_ARM_GROSS_PCT) {
                            const trailingStopLevel = Math.max(TRAILING_FLOOR_GROSS_PCT, peakProfitPct - TRAILING_PULLBACK_PCT);
                            if (profitPercentage <= trailingStopLevel) {
                                isTrailingHit = true;
                            }
                        }

                        const isVExitHit = vInfo.vExhausted && profitPercentage >= (ESTIMATED_ROUNDTRIP_FEE_PCT + 0.25);
                        const isWindowExpired = (candlesElapsed >= MAX_CANDLES_WINDOW || minutesOpen >= MAX_HOLD_MINUTES) && profitPercentage < (ESTIMATED_ROUNDTRIP_FEE_PCT + 0.20);
                        const isStopLossHit = (profitPercentage <= STOP_LOSS_FAST_CUT_PCT || isLiveFlashCrash);
                        const isTpValid = profitPercentage >= vInfo.dynamicTpGrossPct;

                        console.log(`[Wallet 5m] ${symbol} | PnL: ${profitPercentage.toFixed(2)}% | Picco: +${peakProfitPct.toFixed(2)}% | Take Profit: +${vInfo.dynamicTpGrossPct}% | Candele: ${candlesElapsed}/${MAX_CANDLES_WINDOW} (${minutesOpen.toFixed(0)}m)`);

                        const freeCoinAmount = balance.free[rawCurrency] || balance.free[cleanCurrency] || balance.free[`X${cleanCurrency}`] || balance.free[`Z${cleanCurrency}`] || 0;
                        if (freeCoinAmount <= 0.0001) continue;

                        if (isTpValid || isTrailingHit || isVExitHit || isStopLossHit || isWindowExpired) {
                            let reasonType = "TAKE PROFIT DINAMICO";
                            if (isLiveFlashCrash) reasonType = "FLASH CRASH";
                            else if (profitPercentage <= STOP_LOSS_FAST_CUT_PCT) reasonType = `STOP LOSS (${STOP_LOSS_FAST_CUT_PCT}%)`;
                            else if (isTrailingHit) reasonType = `TRAILING STOP (picco +${peakProfitPct.toFixed(2)}%)`;
                            else if (isVExitHit) reasonType = "USCITA V ESAURITA";
                            else if (isTpValid) reasonType = `TAKE PROFIT (+${vInfo.dynamicTpGrossPct}%)`;
                            else if (isWindowExpired) reasonType = `FINESTRA ${MAX_CANDLES_WINDOW} CANDELE (${MAX_HOLD_MINUTES}m)`;

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
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                // 3. SINCRONIZZAZIONE WATCHLIST + VINCENTI DI GIORNATA + VOLUMI CMC
                const currentTime = Date.now();
                if (focusedHotPool.length === 0 || (currentTime - lastHotPoolUpdate > 10 * 60 * 1000)) {
                    let candidateSymbols = [...customWatchlistSymbols];
                    let volumeMap = {};
                    const nextWinnersSet = new Set();

                    if (CMC_API_KEY) {
                        try {
                            const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                                headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                                params: { start: 1, limit: 150, sort: 'volume_24h', sort_dir: 'desc', convert: 'EUR' }
                            });

                            for (const coin of cmcResponse.data.data) {
                                const baseSym = coin.symbol;
                                if (stablecoinsToIgnore.includes(baseSym)) continue;
                                const sym = `${baseSym}/EUR`;
                                volumeMap[baseSym] = coin.quote && coin.quote.EUR ? coin.quote.EUR.volume_24h : 0;

                                const pct24h = coin.quote && coin.quote.EUR ? coin.quote.EUR.percent_change_24h : 0;
                                if (pct24h > 2.0 && exchange.markets[sym] && exchange.markets[sym].active) {
                                    nextWinnersSet.add(sym);
                                    if (!candidateSymbols.includes(sym)) {
                                        candidateSymbols.push(sym);
                                    }
                                }
                            }
                        } catch (e) {}
                    }

                    let validatedWatchlist = [];
                    for (const sym of candidateSymbols) {
                        if (exchange.markets[sym] && exchange.markets[sym].active && !validatedWatchlist.includes(sym)) {
                            validatedWatchlist.push(sym);
                        }
                    }

                    validatedWatchlist.sort((a, b) => {
                        const baseA = a.split('/')[0];
                        const baseB = b.split('/')[0];
                        const volA = volumeMap[baseA] || 0;
                        const volB = volumeMap[baseB] || 0;
                        return volB - volA;
                    });

                    dailyWinnersSet = nextWinnersSet;
                    focusedHotPool = validatedWatchlist;
                    lastHotPoolUpdate = currentTime;
                    console.log(`[Focus] Watchlist (${focusedHotPool.length} coppie): ${focusedHotPool.join(', ')}`);
                }

                if (!isBtcHealthy) {
                    console.log(`[Termometro BTC SEVERO BLOCCATO] ${blockReason} (1h: ${btcChange1h.toFixed(2)}%, 3h: ${btcChange3h.toFixed(2)}%, 15m/4c: ${btcChange15m4c.toFixed(2)}%). Nuovi acquisti sospesi.`);
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                // 4. SCANNER SU CANDELA 5M CON IMPORTO A 10€
                for (const symbol of focusedHotPool) {
                    try {
                        if (!exchange.markets[symbol]) continue;

                        const baseCurrency = symbol.split('/')[0];
                        if (balance.total[baseCurrency] && balance.total[baseCurrency] > 0.0001) continue;
                        const rawKey = Object.keys(balance.total).find(k => k.includes(baseCurrency));
                        if (rawKey && balance.total[rawKey] > 0.0001) continue;

                        const ohlcv5m = await exchange.fetchOHLCV(symbol, TIMEFRAME_ENTRY, undefined, 25);
                        const isDailyWinnerOversold = dailyWinnersSet.has(symbol);
                        const techEval = evaluateTechnicalScore5m(ohlcv5m, isDailyWinnerOversold);

                        if (techEval.score < MIN_ENTRY_SCORE_5M) continue;

                        let targetInvestmentSize = ORDER_SIZE_EUR;
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        if (eurBalance >= ORDER_SIZE_EUR || eurBalance >= 5) {
                            const currentPrice = ohlcv5m[ohlcv5m.length - 1][4];
                            const amountToBuy = targetInvestmentSize / currentPrice;

                            console.log(`[Tentativo Buy 5m] Ordine da €${targetInvestmentSize} su ${symbol} (Score ${techEval.score}) a €${currentPrice}...`);

                            try {
                                const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);

                                activePositions[symbol] = {
                                    entryPrice: currentPrice,
                                    amount: amountToBuy,
                                    time: Date.now(),
                                    peakProfitPct: 0
                                };

                                console.log(`[BUY 5M OK - Score ${techEval.score}] Acquistati €${targetInvestmentSize} di ${symbol} a €${currentPrice.toFixed(4)} | Motivi: ${techEval.details}`);
                                lastLog = `Acquistati €${targetInvestmentSize} di ${symbol} (5m Score ${techEval.score})`;

                                await new Promise(resolve => setTimeout(resolve, 5000));
                                break;
                            } catch (orderErr) {
                                console.log(`[ERRORE ORDINE KRAKEN su ${symbol}]:`, orderErr.message);
                            }
                        }
                    } catch (altErr) {
                        console.log(`[Errore ciclo altcoin 5m]:`, altErr.message);
                    }
                }
            }
        } catch (err) {
            console.log("Errore nel ciclo principale:", err.message);
        }

        await new Promise(resolve => setTimeout(resolve, 20000));
    }
}

app.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
    setTimeout(() => {
        runBotLoop();
    }, 3000);
});
