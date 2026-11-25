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
let lastLog = "Bot Indipendente avviato: Nessun filtro BTC, no BTC/ETH, Fibo + MA + Incrocio MA + Bollinger + SAR + RSI + Volumi (10€).";
let focusedHotPool = [];
let dailyWinnersSet = new Set();
let dailyLosersSet = new Set();
let lastHotPoolUpdate = 0;

let activePositions = {};
let stoppedSymbolsCooldown = {};
let lastBuyTimestamp = 0;

// Escludiamo esplicitamente BTC (XBT) ed ETH (XETH) oltre a EUR e stablecoin
const excludedAssets = new Set([
    'BTC', 'XBT', 'XXBT',
    'ETH', 'XETH',
    'EUR', 'ZEUR', 'USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'KFEE', 'ZUSD'
]);

// Watchlist base (senza BTC ed ETH; Cronos -> CRO)
const customWatchlistSymbols = [
    'PEPE/EUR', 'SUI/EUR', 'SKI/EUR', 'SOL/EUR', 'HYPE/EUR',
    'AAVE/EUR', 'ALLO/EUR', 'WLD/EUR', 'NEAR/EUR', 'SEI/EUR',
    'LINK/EUR', 'GM/EUR', 'CRO/EUR', 'MNT/EUR', 'GRT/EUR',
    'UNI/EUR', 'ENA/EUR'
];

// Soglie Vincenti / Perdenti 24h (CMC + ticker Kraken)
const MOVER_THRESHOLD_PCT = 2.0;

// Parametri Operativi (apertura illimitata fino a TP, trailing o Stop Loss / Fast Cut)
const ORDER_SIZE_EUR = 10;
const FIXED_TP_GROSS_PCT = 1.70;
const TRAILING_ARM_GROSS_PCT = 1.15;
const TRAILING_FLOOR_GROSS_PCT = 0.65;
const TRAILING_PULLBACK_PCT = 0.35;
const STOP_LOSS_FAST_CUT_PCT = -1.35;

// Order Book & Ordine Limite
const MAX_ALLOWED_SPREAD_PCT = 0.50;
const MIN_BOOK_DEPTH_EUR = 150;
const LIMIT_FILL_TIMEOUT_MS = 20000;
const LIMIT_POLL_INTERVAL_MS = 3500;

// Filtro residui / briciole
const MIN_TRACKED_POSITION_EUR = 1.50;
const MIN_COIN_AMOUNT_FLOOR = 0.002;

// Selezione & ritmo ingressi
const MIN_ENTRY_SCORE = 6.0;
const BUY_COOLDOWN_MS = 4 * 60 * 1000;
const SYMBOL_STOP_COOLDOWN_MS = 25 * 60 * 1000;

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Indipendente</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 (Indipendente - No BTC/ETH) - Stato: ${botRunning ? 'ATTIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>TP Lordo:</b> +${FIXED_TP_GROSS_PCT}% | <b>Stop/Fast Cut:</b> ${STOP_LOSS_FAST_CUT_PCT}% | <b>Tempo:</b> Illimitato</p>
                <p><b>Posizioni Attive (>= €${MIN_TRACKED_POSITION_EUR}):</b> ${Object.keys(activePositions).length > 0 ? Object.keys(activePositions).join(', ') : 'Nessuna'}</p>
                <p><b>Watchlist Attiva:</b> ${focusedHotPool.length > 0 ? focusedHotPool.join(', ') : 'Sincronizzazione in corso...'}</p>
            </body>
        </html>
    `);
});

app.post('/api/toggle', (req, res) => {
    botRunning = !botRunning;
    lastLog = `Bot ${botRunning ? 'riattivato' : 'messo in pausa'} via API.`;
    res.json({ success: true, botRunning, message: lastLog });
});

function normalizeAssetCode(rawCurrency) {
    if (!rawCurrency) return '';
    let clean = rawCurrency.toUpperCase().replace(/^[XZ]/, '');
    if (clean === 'XBT') clean = 'BTC';
    return clean;
}

function isExcludedAsset(rawOrCleanCurrency) {
    const upper = (rawOrCleanCurrency || '').toUpperCase();
    const norm = normalizeAssetCode(upper);
    return excludedAssets.has(upper) || excludedAssets.has(norm);
}

function isMeaningfulHolding(amount, priceEur) {
    if (!amount || amount <= MIN_COIN_AMOUNT_FLOOR) return false;
    if (priceEur && priceEur > 0) {
        return (amount * priceEur) >= MIN_TRACKED_POSITION_EUR;
    }
    return amount >= 0.01;
}

// ================= INDICATORI TECNICI =================

function calculateEMA(values, period) {
    if (!values || values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
    for (let i = period; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
}

function calculateSMA(values, period) {
    if (!values || values.length < period) return null;
    const slice = values.slice(-period);
    return slice.reduce((sum, v) => sum + v, 0) / period;
}

function calculateRSI(closes, period = 14) {
    if (!closes || closes.length <= period) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    let avgGain = gains / period;
    let avgLoss = losses / period;

    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        const gain = diff > 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateBollingerBands(closes, period = 20, stdMult = 2) {
    if (!closes || closes.length < period) return null;
    const slice = closes.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);
    return {
        middle: mean,
        upper: mean + stdMult * stdDev,
        lower: mean - stdMult * stdDev
    };
}

// Parabolic SAR classico su serie OHLCV
function calculateParabolicSAR(ohlcv, step = 0.02, maxStep = 0.2) {
    if (!ohlcv || ohlcv.length < 6) return null;

    let isLong = ohlcv[1][4] >= ohlcv[0][4];
    let af = step;
    let ep = isLong ? Math.max(ohlcv[0][2], ohlcv[1][2]) : Math.min(ohlcv[0][3], ohlcv[1][3]);
    let sar = isLong ? ohlcv[0][3] : ohlcv[0][2];
    let flippedNow = false;

    for (let i = 2; i < ohlcv.length; i++) {
        const prevLow = ohlcv[i - 1][3];
        const prevHigh = ohlcv[i - 1][2];
        const curHigh = ohlcv[i][2];
        const curLow = ohlcv[i][3];

        let nextSar = sar + af * (ep - sar);
        flippedNow = false;

        if (isLong) {
            if (i >= 2 && ohlcv[i - 2][3] < nextSar) nextSar = ohlcv[i - 2][3];
            if (prevLow < nextSar) nextSar = prevLow;

            if (curLow < nextSar) {
                isLong = false;
                flippedNow = true;
                sar = ep;
                ep = curLow;
                af = step;
            } else {
                sar = nextSar;
                if (curHigh > ep) {
                    ep = curHigh;
                    af = Math.min(maxStep, af + step);
                }
            }
        } else {
            if (i >= 2 && ohlcv[i - 2][2] > nextSar) nextSar = ohlcv[i - 2][2];
            if (prevHigh > nextSar) nextSar = prevHigh;

            if (curHigh > nextSar) {
                isLong = true;
                flippedNow = true;
                sar = ep;
                ep = curHigh;
                af = step;
            } else {
                sar = nextSar;
                if (curLow < ep) {
                    ep = curLow;
                    af = Math.min(maxStep, af + step);
                }
            }
        }
    }

    return { sar, isLong, flippedNow };
}

// Incrocio media mobile (EMA 9 vs EMA 21 sulle ultime candele)
function evaluateMovingAverageCross(closes) {
    if (!closes || closes.length < 23) {
        return { crossBullish: false, aboveAfterCross: false, label: "NO_CROSS" };
    }
    const prevCloses = closes.slice(0, -1);
    const ema9Prev = calculateEMA(prevCloses, 9);
    const ema21Prev = calculateEMA(prevCloses, 21);
    const ema9Cur = calculateEMA(closes, 9);
    const ema21Cur = calculateEMA(closes, 21);

    if (!ema9Prev || !ema21Prev || !ema9Cur || !ema21Cur) {
        return { crossBullish: false, aboveAfterCross: false, label: "NO_CROSS" };
    }

    const crossBullish = ema9Prev <= ema21Prev && ema9Cur > ema21Cur;
    const aboveAfterCross = ema9Cur > ema21Cur && closes[closes.length - 1] >= ema9Cur * 0.999;

    if (crossBullish) {
        return { crossBullish: true, aboveAfterCross: true, label: "INCROCIO_EMA9>21" };
    }
    if (aboveAfterCross) {
        return { crossBullish: false, aboveAfterCross: true, label: "SOPRA_INCROCIO_EMA" };
    }
    return { crossBullish: false, aboveAfterCross: false, label: "MA_NON_INCROCIATE" };
}

// Fibonacci sul range recente
function evaluateFibonacciZone(ohlcv, currentPrice) {
    if (!ohlcv || ohlcv.length < 12) {
        return { ok: true, score: 0, zone: "FIB_ND" };
    }
    const slice = ohlcv.slice(-24);
    const swingLow = Math.min(...slice.map(c => c[3]));
    const swingHigh = Math.max(...slice.map(c => c[2]));
    const diff = swingHigh - swingLow;
    if (!swingLow || !swingHigh || diff <= 0) {
        return { ok: true, score: 0, zone: "FIB_PIATTO" };
    }

    const fib0236 = swingHigh - diff * 0.236;
    const fib0382 = swingHigh - diff * 0.382;
    const fib0500 = swingHigh - diff * 0.500;
    const fib0618 = swingHigh - diff * 0.618;
    const fib0786 = swingHigh - diff * 0.786;

    if (currentPrice < fib0786 * 0.997) {
        return { ok: false, score: -1.5, zone: "FIB_ROTTO_0.786" };
    }
    if (currentPrice >= fib0382) {
        return { ok: true, score: 1.0, zone: currentPrice >= fib0236 ? "FIB_0.236" : "FIB_0.382" };
    }
    if (currentPrice >= fib0618) {
        return { ok: true, score: 1.35, zone: currentPrice >= fib0500 ? "FIB_0.50" : "FIB_0.618" };
    }
    return { ok: true, score: 0.4, zone: "FIB_0.618-0.786" };
}

// Interpretazione intelligente del volume
function interpretVolume(lastCandle, prevCandle, avgVol) {
    if (!lastCandle || !avgVol || avgVol <= 0) {
        return { label: "VOL_ND", scoreDelta: 0, toxic: false };
    }
    const open = lastCandle[1];
    const high = lastCandle[2];
    const low = lastCandle[3];
    const close = lastCandle[4];
    const vol = lastCandle[5] || 0;
    const ratio = vol / avgVol;

    const isGreen = close >= open;
    const range = Math.max(high - low, 1e-12);
    const upperWickRatio = (high - Math.max(open, close)) / range;

    if (!isGreen && ratio >= 1.2 && close < (prevCandle ? prevCandle[4] : open)) {
        return { label: `SCARICO_VOL(${ratio.toFixed(1)}x)`, scoreDelta: -1.5, toxic: true };
    }
    if (ratio >= 2.2 && upperWickRatio >= 0.45) {
        return { label: `WICK_VOL(${ratio.toFixed(1)}x)`, scoreDelta: -0.75, toxic: false };
    }
    if (isGreen && ratio >= 1.15) {
        return { label: `SPINTA_VOL(${ratio.toFixed(1)}x)`, scoreDelta: 1.0, toxic: false };
    }
    if (ratio < 0.75 && isGreen) {
        return { label: `BASSO_ORDINATO(${ratio.toFixed(1)}x)`, scoreDelta: 0.25, toxic: false };
    }
    return { label: `VOL(${ratio.toFixed(1)}x)`, scoreDelta: isGreen ? 0.4 : -0.2, toxic: false };
}

// ================= VALUTAZIONE COMPLETA SETUP SU QUALSIASI ASSET =================

function evaluateAssetOpportunity(ohlcv5m, ohlcv15m, ohlcv30m, isWinner, isLoser) {
    if (!ohlcv5m || ohlcv5m.length < 25 || !ohlcv15m || ohlcv15m.length < 25 || !ohlcv30m || ohlcv30m.length < 20) {
        return { valid: false, score: 0, reason: "Dati insufficienti" };
    }

    const closes5m = ohlcv5m.map(c => c[4]);
    const lows5m = ohlcv5m.map(c => c[3]);
    const vols5m = ohlcv5m.map(c => c[5]);

    const closes15m = ohlcv15m.map(c => c[4]);
    const lows15m = ohlcv15m.map(c => c[3]);

    const lows30m = ohlcv30m.map(c => c[3]);
    const highs30m = ohlcv30m.map(c => c[2]);

    const currentPrice = closes5m[closes5m.length - 1];
    const prevClose5m = closes5m[closes5m.length - 2];

    // 1. Fibonacci
    const fib5m = evaluateFibonacciZone(ohlcv5m, currentPrice);
    const fib15m = evaluateFibonacciZone(ohlcv15m, currentPrice);
    if (!fib5m.ok && !fib15m.ok) {
        return { valid: false, score: -1, reason: "Fibonacci rotto su 5m e 15m" };
    }

    // 2. Medie mobili & Incrocio media mobile
    const ema9_5m = calculateEMA(closes5m, 9);
    const ema21_5m = calculateEMA(closes5m, 21);
    const sma50_15m = calculateSMA(closes15m, 50) || calculateSMA(closes15m, 20);
    const maCross5m = evaluateMovingAverageCross(closes5m);
    const maCross15m = evaluateMovingAverageCross(closes15m);

    // 3. Bollinger Bands
    const bb5m = calculateBollingerBands(closes5m, 20, 2);
    const bb15m = calculateBollingerBands(closes15m, 20, 2);

    // 4. Parabolic SAR
    const sar5m = calculateParabolicSAR(ohlcv5m, 0.02, 0.2);
    const sar15m = calculateParabolicSAR(ohlcv15m, 0.02, 0.2);

    // 5. RSI
    const rsi5m = calculateRSI(closes5m, 14);
    const rsi15m = calculateRSI(closes15m, 14);

    // 6. Volume interpretato
    const avgVol5m = vols5m.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
    const volCtx = interpretVolume(ohlcv5m[ohlcv5m.length - 1], ohlcv5m[ohlcv5m.length - 2], avgVol5m);
    if (volCtx.toxic) {
        return { valid: false, score: -2, reason: volCtx.label };
    }

    // Supporti e spazio verso resistenza
    const sup5m = Math.min(...lows5m.slice(-16, -1));
    const sup15m = Math.min(...lows15m.slice(-16, -1));
    const sup30m = Math.min(...lows30m.slice(-16, -1));
    const res30m = Math.max(...highs30m.slice(-12));
    const roomToResPct = currentPrice > 0 ? ((res30m - currentPrice) / currentPrice) * 100 : 0;

    let score = 0;
    const reasons = [];

    // Fibonacci score
    score += fib5m.score + (fib15m.score * 0.6);
    reasons.push(fib5m.zone);

    // Incrocio e posizione medie mobili
    if (maCross5m.crossBullish || maCross15m.crossBullish) {
        score += 2.0;
        reasons.push(maCross5m.crossBullish ? maCross5m.label : maCross15m.label);
    } else if (maCross5m.aboveAfterCross || (ema9_5m && ema21_5m && currentPrice >= ema9_5m && ema9_5m >= ema21_5m * 0.998)) {
        score += 1.25;
        reasons.push("EMA9>21");
    }
    if (sma50_15m && currentPrice >= sma50_15m * 0.996) {
        score += 0.75;
        reasons.push("Sopra MA15m");
    }

    // Bollinger score
    if (bb5m && currentPrice <= bb5m.middle && currentPrice >= bb5m.lower * 0.996 && currentPrice >= prevClose5m) {
        score += 1.25;
        reasons.push("BB 5m rimbalzo");
    } else if (bb5m && currentPrice > bb5m.middle && currentPrice < bb5m.upper && currentPrice >= prevClose5m) {
        score += 0.75;
        reasons.push("BB 5m spinta");
    }
    if (bb15m && currentPrice >= bb15m.lower * 0.996 && currentPrice <= bb15m.upper) {
        score += 0.5;
        reasons.push("BB 15m OK");
    }

    // Parabolic SAR score
    if (sar5m && sar5m.isLong) {
        score += sar5m.flippedNow ? 1.5 : 1.0;
        reasons.push(sar5m.flippedNow ? "SAR5m GIRATO LONG" : "SAR5m sotto");
    } else if (sar5m && !sar5m.isLong) {
        score -= 1.0;
        reasons.push("SAR5m sopra");
    }
    if (sar15m && sar15m.isLong) {
        score += 0.75;
        reasons.push("SAR15m sotto");
    }

    // RSI score
    if (rsi5m >= 28 && rsi5m <= 62 && currentPrice >= prevClose5m) {
        score += 1.25;
        reasons.push(`RSI5m ${rsi5m.toFixed(0)}`);
    } else if (rsi5m > 70 || rsi15m > 72) {
        score -= 2.0;
        reasons.push(`RSI tirato ${rsi5m.toFixed(0)}`);
    }

    // Volume score
    score += volCtx.scoreDelta;
    reasons.push(volCtx.label);

    // Gainer / Loser
    if (isWinner) {
        score += 0.75;
        reasons.push("Gainer");
    } else if (isLoser && rsi5m <= 50 && currentPrice >= prevClose5m) {
        score += 0.75;
        reasons.push("Loser rimbalzo");
    }

    // Supporto / resistenza
    const nearSupport =
        (sup5m > 0 && ((currentPrice - sup5m) / sup5m) * 100 <= 1.0) ||
        (sup15m > 0 && ((currentPrice - sup15m) / sup15m) * 100 <= 1.35) ||
        (sup30m > 0 && ((currentPrice - sup30m) / sup30m) * 100 <= 1.65);

    if (nearSupport) {
        score += 1.0;
        reasons.push("Su supporto");
    }
    if (roomToResPct < 1.1) {
        score -= 1.25;
        reasons.push(`Res vicina +${roomToResPct.toFixed(1)}%`);
    }

    const valid = currentPrice >= prevClose5m && score >= MIN_ENTRY_SCORE;
    return {
        valid,
        score,
        reason: reasons.join(" + ")
    };
}

// ================= ORDER BOOK & ORDINI LIMITE =================

async function evaluateOrderBookForExecution(symbol, side = 'buy') {
    try {
        const book = await exchange.fetchOrderBook(symbol, 15);
        const bids = Array.isArray(book?.bids) ? book.bids : [];
        const asks = Array.isArray(book?.asks) ? book.asks : [];

        if (bids.length === 0 || asks.length === 0) {
            return { ok: false, reason: "Book vuoto" };
        }

        const bestBid = bids[0][0];
        const bestAsk = asks[0][0];
        if (!bestBid || !bestAsk || bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) {
            return { ok: false, reason: "Prezzi bid/ask non validi" };
        }

        const spreadPct = ((bestAsk - bestBid) / ((bestBid + bestAsk) / 2)) * 100;
        if (spreadPct > MAX_ALLOWED_SPREAD_PCT) {
            return { ok: false, bestBid, bestAsk, spreadPct, reason: `Spread largo (${spreadPct.toFixed(2)}% > ${MAX_ALLOWED_SPREAD_PCT}%)` };
        }

        const levelsToCheck = side === 'buy' ? asks.slice(0, 10) : bids.slice(0, 10);
        let depthEur = 0;
        for (const lvl of levelsToCheck) {
            if (typeof lvl[0] === 'number' && typeof lvl[1] === 'number' && lvl[0] > 0 && lvl[1] > 0) {
                depthEur += lvl[0] * lvl[1];
            }
        }

        if (depthEur < MIN_BOOK_DEPTH_EUR) {
            return { ok: false, bestBid, bestAsk, spreadPct, depthEur, reason: `Profondità bassa (€${depthEur.toFixed(0)} < €${MIN_BOOK_DEPTH_EUR})` };
        }

        return { ok: true, bestBid, bestAsk, spreadPct, depthEur, reason: `Book OK (spread ${spreadPct.toFixed(2)}%, prof €${depthEur.toFixed(0)})` };
    } catch (e) {
        return { ok: false, reason: `Errore book: ${e.message}` };
    }
}

async function placeTimedLimitBuyOnBook(symbol, amountToBuy, bookInfo) {
    const rawLimitPrice = bookInfo && bookInfo.bestBid ? bookInfo.bestBid : 0;
    if (!rawLimitPrice || rawLimitPrice <= 0) {
        return { filled: false, reason: "Bid non disponibile" };
    }

    const formattedPrice = Number(exchange.priceToPrecision(symbol, rawLimitPrice));
    const formattedAmount = Number(exchange.amountToPrecision(symbol, amountToBuy));

    if (!formattedPrice || !formattedAmount || formattedAmount <= 0) {
        return { filled: false, reason: "Quantità/prezzo non formattabili" };
    }

    const order = await exchange.createLimitBuyOrder(symbol, formattedAmount, formattedPrice);
    const orderId = order?.id;
    console.log(`[LIMIT BUY] ${symbol}: ${formattedAmount} @ €${formattedPrice} (ID: ${orderId || 'N/D'})`);

    if (!orderId) {
        return { filled: true, execPrice: formattedPrice, amount: formattedAmount, order };
    }

    const deadline = Date.now() + LIMIT_FILL_TIMEOUT_MS;
    let filledAmount = 0;
    let avgPrice = formattedPrice;

    while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, LIMIT_POLL_INTERVAL_MS));

        try {
            const currentOrder = await exchange.fetchOrder(orderId, symbol);
            const status = currentOrder?.status;
            filledAmount = typeof currentOrder?.filled === 'number' ? currentOrder.filled : filledAmount;
            if (typeof currentOrder?.average === 'number' && currentOrder.average > 0) {
                avgPrice = currentOrder.average;
            } else if (typeof currentOrder?.price === 'number' && currentOrder.price > 0) {
                avgPrice = currentOrder.price;
            }

            if (status === 'closed' || (filledAmount > 0 && filledAmount >= formattedAmount * 0.995)) {
                return { filled: true, execPrice: avgPrice, amount: filledAmount > 0 ? filledAmount : formattedAmount, order: currentOrder };
            }

            const ticker = await exchange.fetchTicker(symbol);
            if (ticker && typeof ticker.last === 'number' && ticker.last > formattedPrice * 1.0035) {
                console.log(`[LIMIT IN RITARDO] ${symbol} a €${ticker.last} > €${formattedPrice}, cancello.`);
                break;
            }
        } catch (pollErr) {
            console.log(`[Poll Limite ${symbol}]: ${pollErr.message}`);
        }
    }

    try {
        await exchange.cancelOrder(orderId, symbol);
        const afterCancel = await exchange.fetchOrder(orderId, symbol).catch(() => null);
        const partialFilled = typeof afterCancel?.filled === 'number' ? afterCancel.filled : filledAmount;
        const partialAvg = (typeof afterCancel?.average === 'number' && afterCancel.average > 0) ? afterCancel.average : avgPrice;

        if (partialFilled > 0 && (partialFilled * partialAvg) >= MIN_TRACKED_POSITION_EUR) {
            return { filled: true, partial: true, execPrice: partialAvg, amount: partialFilled, order: afterCancel };
        }
    } catch (cancelErr) {
        console.log(`[Cancel Limite ${symbol}]: ${cancelErr.message}`);
    }

    return { filled: false, reason: `Limite non eseguito entro ${Math.round(LIMIT_FILL_TIMEOUT_MS / 1000)}s` };
}

// ================= CICLO PRINCIPALE =================

async function runBotLoop() {
    while (true) {
        try {
            if (botRunning) {
                const now = new Date().toLocaleString();
                await exchange.loadMarkets();

                const balance = await exchange.fetchBalance();
                const eurBalance = balance.free['EUR'] || balance.free['ZEUR'] || 0;
                console.log(`[${now}] Saldo EUR: €${eurBalance.toFixed(2)}`);

                const totalBalances = balance.total || {};

                // Filtra solo asset NON esclusi (esclude sempre BTC e ETH)
                const assetKeys = Object.keys(totalBalances).filter(rawCurrency => {
                    if (isExcludedAsset(rawCurrency)) return false;
                    const amt = totalBalances[rawCurrency] || 0;
                    if (amt <= MIN_COIN_AMOUNT_FLOOR) return false;
                    return !isExcludedAsset(normalizeAssetCode(rawCurrency));
                });

                // 1. GESTIONE POSIZIONI APERTE (ESCLUSI BTC E ETH)
                const trackedSymbolsSet = new Set();

                for (const rawCurrency of assetKeys) {
                    const cleanCurrency = normalizeAssetCode(rawCurrency);
                    if (isExcludedAsset(cleanCurrency)) continue;

                    let symbol = `${cleanCurrency}/EUR`;
                    if (!exchange.markets[symbol]) {
                        symbol = `${rawCurrency}/EUR`;
                        if (!exchange.markets[symbol]) continue;
                    }
                    if (symbol === 'BTC/EUR' || symbol === 'XBT/EUR' || symbol === 'ETH/EUR' || symbol === 'XETH/EUR') {
                        continue;
                    }

                    try {
                        const totalAmt = totalBalances[rawCurrency] || 0;
                        const freeCoinAmount = balance.free[rawCurrency] || balance.free[cleanCurrency] || balance.free[`X${cleanCurrency}`] || balance.free[`Z${cleanCurrency}`] || 0;

                        const ticker = await exchange.fetchTicker(symbol);
                        const currentPrice = ticker.last;

                        if (!isMeaningfulHolding(totalAmt, currentPrice) || !isMeaningfulHolding(freeCoinAmount, currentPrice)) {
                            if (activePositions[symbol]) delete activePositions[symbol];
                            continue;
                        }

                        trackedSymbolsSet.add(symbol);

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

                        let isTrailingHit = false;
                        if (peakProfitPct >= TRAILING_ARM_GROSS_PCT) {
                            const trailingStopLevel = Math.max(TRAILING_FLOOR_GROSS_PCT, peakProfitPct - TRAILING_PULLBACK_PCT);
                            if (profitPercentage <= trailingStopLevel) {
                                isTrailingHit = true;
                            }
                        }

                        const isTpHit = profitPercentage >= FIXED_TP_GROSS_PCT;
                        const isStopLossHit = profitPercentage <= STOP_LOSS_FAST_CUT_PCT;

                        console.log(`[Posizione] ${symbol} (€${(freeCoinAmount * currentPrice).toFixed(2)}) | PnL: ${profitPercentage.toFixed(2)}% | Picco: +${peakProfitPct.toFixed(2)}% | TP: +${FIXED_TP_GROSS_PCT}% | Aperta: ${minutesOpen.toFixed(0)}m`);

                        if (isTpHit || isTrailingHit || isStopLossHit) {
                            let reasonType = `TP LORDO (+${FIXED_TP_GROSS_PCT}%)`;
                            if (isStopLossHit) reasonType = `STOP LOSS / FAST CUT (${STOP_LOSS_FAST_CUT_PCT}%)`;
                            else if (isTrailingHit) reasonType = `TRAILING PROTETTIVO (picco +${peakProfitPct.toFixed(2)}%)`;

                            const sellBook = await evaluateOrderBookForExecution(symbol, 'sell');
                            if (!sellBook.ok && !isStopLossHit) {
                                console.log(`[BOOK VENDITA IN ATTESA] ${symbol}: ${sellBook.reason}. Rimando chiusura.`);
                                continue;
                            }

                            console.log(`[VENDITA] Chiusura (${reasonType}) su ${symbol} (PnL: ${profitPercentage.toFixed(2)}%)...`);
                            const sellRes = await exchange.createMarketSellOrder(symbol, freeCoinAmount);
                            console.log(`[VENDITA OK] ${symbol} chiusa! ID:`, sellRes.id);
                            lastLog = `Chiuso ${symbol} (${reasonType}) - PnL: ${profitPercentage.toFixed(2)}%`;

                            delete activePositions[symbol];
                            if (isStopLossHit) {
                                lastBuyTimestamp = Date.now();
                                stoppedSymbolsCooldown[symbol] = Date.now() + SYMBOL_STOP_COOLDOWN_MS;
                            }
                            await new Promise(resolve => setTimeout(resolve, 3000));
                        }
                    } catch (errPort) {
                        console.log(`Errore asset ${symbol}:`, errPort.message);
                    }
                }

                for (const keySym of Object.keys(activePositions)) {
                    if (!trackedSymbolsSet.has(keySym)) {
                        delete activePositions[keySym];
                    }
                }

                // 2. WATCHLIST + VINCENTI & PERDENTI (KRAKEN + CMC, SENZA BTC/ETH)
                const currentTime = Date.now();
                if (focusedHotPool.length === 0 || (currentTime - lastHotPoolUpdate > 10 * 60 * 1000)) {
                    let candidateSymbols = [...customWatchlistSymbols];
                    let volumeMap = {};
                    const nextWinnersSet = new Set();
                    const nextLosersSet = new Set();

                    try {
                        const eurMarketSymbols = Object.keys(exchange.markets).filter(sym => {
                            if (!sym.endsWith('/EUR')) return false;
                            const m = exchange.markets[sym];
                            if (!m || !m.active) return false;
                            const base = sym.split('/')[0];
                            return !isExcludedAsset(base);
                        });

                        const tickers = await exchange.fetchTickers(eurMarketSymbols);
                        for (const sym of eurMarketSymbols) {
                            const t = tickers[sym];
                            if (!t) continue;
                            const quoteVol = typeof t.quoteVolume === 'number' && t.quoteVolume > 0
                                ? t.quoteVolume
                                : (typeof t.baseVolume === 'number' && typeof t.last === 'number' ? t.baseVolume * t.last : 0);
                            if (quoteVol > 0) volumeMap[sym] = quoteVol;

                            let pct = typeof t.percentage === 'number' ? t.percentage : null;
                            if (pct === null && typeof t.open === 'number' && t.open > 0 && typeof t.last === 'number') {
                                pct = ((t.last - t.open) / t.open) * 100;
                            }

                            if (typeof pct === 'number') {
                                if (pct >= MOVER_THRESHOLD_PCT) {
                                    nextWinnersSet.add(sym);
                                    if (!candidateSymbols.includes(sym)) candidateSymbols.push(sym);
                                } else if (pct <= -MOVER_THRESHOLD_PCT) {
                                    nextLosersSet.add(sym);
                                    if (!candidateSymbols.includes(sym)) candidateSymbols.push(sym);
                                }
                            }
                        }
                    } catch (krakenMoversErr) {
                        console.log(`[Movers Kraken] Errore: ${krakenMoversErr.message}`);
                    }

                    if (CMC_API_KEY) {
                        try {
                            const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                                headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                                params: { start: 1, limit: 150, sort: 'volume_24h', sort_dir: 'desc', convert: 'EUR' }
                            });

                            for (const coin of cmcResponse.data.data) {
                                const baseSym = coin.symbol;
                                if (isExcludedAsset(baseSym)) continue;
                                const sym = `${baseSym}/EUR`;
                                const cmcVol = coin.quote && coin.quote.EUR ? coin.quote.EUR.volume_24h : 0;
                                if (cmcVol > (volumeMap[sym] || 0)) volumeMap[sym] = cmcVol;

                                const pct24h = coin.quote && coin.quote.EUR ? coin.quote.EUR.percent_change_24h : 0;
                                if (exchange.markets[sym] && exchange.markets[sym].active) {
                                    if (pct24h >= MOVER_THRESHOLD_PCT) {
                                        nextWinnersSet.add(sym);
                                        if (!candidateSymbols.includes(sym)) candidateSymbols.push(sym);
                                    } else if (pct24h <= -MOVER_THRESHOLD_PCT) {
                                        nextLosersSet.add(sym);
                                        if (!candidateSymbols.includes(sym)) candidateSymbols.push(sym);
                                    }
                                }
                            }
                        } catch (cmcErr) {
                            console.log(`[Movers CMC] Errore: ${cmcErr.message}`);
                        }
                    }

                    let validatedWatchlist = [];
                    for (const sym of candidateSymbols) {
                        const base = sym.split('/')[0];
                        if (!isExcludedAsset(base) && exchange.markets[sym] && exchange.markets[sym].active && !validatedWatchlist.includes(sym)) {
                            validatedWatchlist.push(sym);
                        }
                    }

                    validatedWatchlist.sort((a, b) => (volumeMap[b] || 0) - (volumeMap[a] || 0));

                    dailyWinnersSet = nextWinnersSet;
                    dailyLosersSet = nextLosersSet;
                    focusedHotPool = validatedWatchlist;
                    lastHotPoolUpdate = currentTime;
                    console.log(`[Focus] Watchlist (${focusedHotPool.length} coppie | Vincenti: ${dailyWinnersSet.size}, Perdenti: ${dailyLosersSet.size} | No BTC/ETH)`);
                }

                if (Date.now() - lastBuyTimestamp < BUY_COOLDOWN_MS) {
                    const waitMin = Math.ceil((BUY_COOLDOWN_MS - (Date.now() - lastBuyTimestamp)) / 60000);
                    console.log(`[Cooldown] Attesa ${waitMin}m prima del prossimo ingresso da €${ORDER_SIZE_EUR}.`);
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                // 3. SCANNER OPPORTUNITÀ SU QUALSIASI ASSET (NO BTC/ETH)
                for (const symbol of focusedHotPool) {
                    try {
                        const baseCurrency = symbol.split('/')[0];
                        if (isExcludedAsset(baseCurrency) || !exchange.markets[symbol]) continue;
                        if (stoppedSymbolsCooldown[symbol] && Date.now() < stoppedSymbolsCooldown[symbol]) continue;

                        const [ohlcv5m, ohlcv15m, ohlcv30m] = await Promise.all([
                            exchange.fetchOHLCV(symbol, '5m', undefined, 55),
                            exchange.fetchOHLCV(symbol, '15m', undefined, 55),
                            exchange.fetchOHLCV(symbol, '30m', undefined, 30)
                        ]);
                        if (!ohlcv5m || ohlcv5m.length < 25 || !ohlcv15m || ohlcv15m.length < 25 || !ohlcv30m || ohlcv30m.length < 20) continue;

                        const currentPrice = ohlcv5m[ohlcv5m.length - 1][4];
                        const matchingKeys = Object.keys(totalBalances).filter(k => normalizeAssetCode(k) === baseCurrency);
                        const existingTotalAmt = matchingKeys.reduce((sum, k) => sum + (totalBalances[k] || 0), 0);
                        if (isMeaningfulHolding(existingTotalAmt, currentPrice)) continue;

                        const setup = evaluateAssetOpportunity(
                            ohlcv5m,
                            ohlcv15m,
                            ohlcv30m,
                            dailyWinnersSet.has(symbol),
                            dailyLosersSet.has(symbol)
                        );
                        if (!setup.valid) continue;

                        const bookEval = await evaluateOrderBookForExecution(symbol, 'buy');
                        if (!bookEval.ok) {
                            console.log(`[Book Filtro Buy] ${symbol} saltato: ${bookEval.reason}`);
                            continue;
                        }

                        let targetInvestmentSize = ORDER_SIZE_EUR;
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        if (eurBalance >= ORDER_SIZE_EUR || eurBalance >= 5) {
                            const refPrice = bookEval.bestBid > 0 ? bookEval.bestBid : currentPrice;
                            const amountToBuy = targetInvestmentSize / refPrice;

                            console.log(`[Buy Setup] Limite €${targetInvestmentSize} su ${symbol} (Score ${setup.score.toFixed(1)}) | ${setup.reason} | ${bookEval.reason}...`);

                            try {
                                const limitResult = await placeTimedLimitBuyOnBook(symbol, amountToBuy, bookEval);
                                if (!limitResult.filled) {
                                    console.log(`[Limit Non Eseguito] ${symbol}: ${limitResult.reason}`);
                                    continue;
                                }

                                const actualEntry = limitResult.execPrice || refPrice;
                                const actualAmount = limitResult.amount || amountToBuy;

                                activePositions[symbol] = {
                                    entryPrice: actualEntry,
                                    amount: actualAmount,
                                    time: Date.now(),
                                    peakProfitPct: 0
                                };
                                lastBuyTimestamp = Date.now();
                                console.log(`[BUY LIMIT OK] Acquistati ~€${(actualAmount * actualEntry).toFixed(2)} di ${symbol} @ €${actualEntry} | ${setup.reason}`);
                                lastLog = `Acquistati ~€${(actualAmount * actualEntry).toFixed(2)} di ${symbol}`;
                                await new Promise(resolve => setTimeout(resolve, 5000));
                                break;
                            } catch (orderErr) {
                                console.log(`[ERRORE ORDINE KRAKEN su ${symbol}]:`, orderErr.message);
                            }
                        }
                    } catch (altErr) {
                        console.log(`[Errore ciclo asset]:`, altErr.message);
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
    console.log(`Server Indipendente in ascolto sulla porta ${PORT}`);
    setTimeout(() => {
        runBotLoop();
    }, 3000);
});
