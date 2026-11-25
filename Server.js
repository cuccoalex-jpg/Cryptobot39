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
let lastLog = "Bot Confronto Macro <-> BTC avviato: Lettura Posizione BTC + Fibo Multi-TF + TP Dinamico (10€).";
let focusedHotPool = [];
let dailyWinnersSet = new Set();
let dailyLosersSet = new Set();
let lastHotPoolUpdate = 0;
global.lastBtcLivePrice = 0;

let activePositions = {};
let stoppedSymbolsCooldown = {};
let macroLockedUntil = 0;
let lastBuyTimestamp = 0;

const stablecoinsToIgnore = ['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'ZEUR', 'KFEE', 'EUR', 'ZUSD'];

// Watchlist base (senza ETH; Cronos -> CRO; coppie non attive su Kraken vengono scartate in automatico)
const customWatchlistSymbols = [
    'PEPE/EUR', 'SUI/EUR', 'SKI/EUR', 'SOL/EUR', 'HYPE/EUR',
    'AAVE/EUR', 'ALLO/EUR', 'WLD/EUR', 'NEAR/EUR', 'SEI/EUR',
    'LINK/EUR', 'GM/EUR', 'CRO/EUR', 'MNT/EUR', 'GRT/EUR',
    'UNI/EUR', 'ENA/EUR'
];

// Soglie Vincenti / Perdenti 24h (CMC + ticker Kraken)
const MOVER_THRESHOLD_PCT = 2.0;

// Parametri Operativi (tempo illimitato fino a TP dinamico, incasso su asset incerto/debole, trailing o Stop Loss)
const ORDER_SIZE_EUR = 10;
const MIN_TRACKED_POSITION_EUR = 1.50;
const MIN_COIN_AMOUNT_FLOOR = 0.002;

// Take Profit Dinamico Lordo
const UNCERTAIN_ASSET_TP_GROSS_PCT = 0.95;
const UNCERTAIN_FAST_PROFIT_GROSS_PCT = 0.75;
const STANDARD_TP_GROSS_PCT = 1.65;
const STRONG_TREND_TP_GROSS_PCT = 2.30;

// Protezione trailing e Stop Loss / Fast Cut
const TRAILING_ARM_GROSS_PCT = 1.00;
const TRAILING_FLOOR_GROSS_PCT = 0.60;
const TRAILING_PULLBACK_PCT = 0.30;
const ALARM_TRAILING_PULLBACK_PCT = 0.22;
const STOP_LOSS_FAST_CUT_PCT = -1.35;

// Order Book: controllo spread, profondità e ordine limite temporizzato
const MAX_ALLOWED_SPREAD_PCT = 0.50;
const MIN_BOOK_DEPTH_EUR = 150;
const LIMIT_FILL_TIMEOUT_MS = 20000;
const LIMIT_POLL_INTERVAL_MS = 3500;

// Selezione & ritmo ingressi
const MIN_TECHNICAL_ENTRY_SCORE = 5.5;
const BUY_COOLDOWN_MS = 5 * 60 * 1000;
const SYMBOL_STOP_COOLDOWN_MS = 30 * 60 * 1000;

// Macro & Geopolitica (solo mercati USA aperti lun-ven 15:00-22:30 ora italiana)
const MACRO_INDEX_MAX_DROP_PCT = -1.2;
const OIL_SHOCK_MAX_SPIKE_PCT = 3.5;
const MACRO_LOCK_DURATION_MS = 15 * 60 * 1000;

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Macro <-> BTC</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 (Confronto Macro <-> BTC) - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>TP Dinamico Lordo:</b> Incerto ~+${UNCERTAIN_ASSET_TP_GROSS_PCT}% | Base +${STANDARD_TP_GROSS_PCT}% | Forte +${STRONG_TREND_TP_GROSS_PCT}% | <b>Stop/Fast Cut:</b> ${STOP_LOSS_FAST_CUT_PCT}%</p>
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

function isMeaningfulHolding(amount, priceEur) {
    if (!amount || amount <= MIN_COIN_AMOUNT_FLOOR) return false;
    if (priceEur && priceEur > 0) {
        return (amount * priceEur) >= MIN_TRACKED_POSITION_EUR;
    }
    return amount >= 0.01;
}

function getItalyDayAndMinutes() {
    const now = new Date();
    const italyParts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Rome',
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).formatToParts(now);

    const weekday = italyParts.find(p => p.type === 'weekday')?.value || '';
    const hour = parseInt(italyParts.find(p => p.type === 'hour')?.value || '0', 10);
    const minute = parseInt(italyParts.find(p => p.type === 'minute')?.value || '0', 10);
    const minutesFromMidnight = hour * 60 + minute;

    const isWeekend = weekday === 'Sat' || weekday === 'Sun';
    const isUsMarketSession = !isWeekend && minutesFromMidnight >= (15 * 60) && minutesFromMidnight <= (22 * 60 + 30);

    return { weekday, isWeekend, isUsMarketSession, minutesFromMidnight };
}

// ================= INDICATORI TECNICI (EMA, RSI, BOLLINGER, FIBONACCI, VOLUMI) =================

function calculateEMA(values, period) {
    if (!values || values.length < period) return null;
    const k = 2 / (period + 1);
    let ema = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
    for (let i = period; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
    }
    return ema;
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

function interpretVolumeContext(lastCandle, prevCandle, avgVol) {
    if (!lastCandle || !avgVol || avgVol <= 0) {
        return { label: "VOL_ND", scoreDelta: 0, allowLowVolMove: true };
    }
    const open = lastCandle[1];
    const high = lastCandle[2];
    const low = lastCandle[3];
    const close = lastCandle[4];
    const vol = lastCandle[5] || 0;
    const ratio = vol / avgVol;

    const isGreen = close >= open;
    const candleRange = Math.max(high - low, 1e-12);
    const bodySize = Math.abs(close - open);
    const upperWickRatio = (high - Math.max(open, close)) / candleRange;

    if (!isGreen && ratio >= 1.15 && close < (prevCandle ? prevCandle[4] : open)) {
        return { label: `SCARICO_VOL(${ratio.toFixed(1)}x)`, scoreDelta: -1.5, allowLowVolMove: false };
    }
    if (ratio >= 2.2 && (upperWickRatio >= 0.45 || bodySize / candleRange < 0.30)) {
        return { label: `SPIKE_OMBRA(${ratio.toFixed(1)}x)`, scoreDelta: -0.75, allowLowVolMove: true };
    }
    if (isGreen && ratio >= 1.15) {
        return { label: `SPINTA_VOL(${ratio.toFixed(1)}x)`, scoreDelta: 1.0, allowLowVolMove: true };
    }
    if (ratio < 0.75) {
        if (isGreen) {
            return { label: `BASSO_ORDINATO(${ratio.toFixed(1)}x)`, scoreDelta: 0.25, allowLowVolMove: true };
        }
        return { label: `BASSO_FIACCO(${ratio.toFixed(1)}x)`, scoreDelta: -0.4, allowLowVolMove: false };
    }
    return { label: `NORMALE(${ratio.toFixed(1)}x)`, scoreDelta: isGreen ? 0.5 : 0, allowLowVolMove: true };
}

function calculateFibonacciLevels(swingLow, swingHigh) {
    const diff = swingHigh - swingLow;
    if (!swingLow || !swingHigh || diff <= 0) return null;
    return {
        swingLow,
        swingHigh,
        fib0236: swingHigh - diff * 0.236,
        fib0382: swingHigh - diff * 0.382,
        fib0500: swingHigh - diff * 0.500,
        fib0618: swingHigh - diff * 0.618,
        fib0786: swingHigh - diff * 0.786
    };
}

function evaluateSingleTimeframeFibo(ohlcv, lookbackCandles, livePrice, label) {
    if (!ohlcv || ohlcv.length < Math.min(8, lookbackCandles)) {
        return { label, valid: false, ok: true, score: 0, zone: "N/D" };
    }
    const slice = ohlcv.slice(-lookbackCandles);
    const swingLow = Math.min(...slice.map(c => c[3]));
    const swingHigh = Math.max(...slice.map(c => c[2]));
    const fib = calculateFibonacciLevels(swingLow, swingHigh);
    if (!fib) {
        return { label, valid: false, ok: true, score: 0, zone: "PIATTO" };
    }

    const lastCandle = slice[slice.length - 1];
    const prevCandle = slice[slice.length - 2] || lastCandle;
    const holdingOrRising = livePrice >= lastCandle[1] || lastCandle[4] >= prevCandle[4];

    if (livePrice < fib.fib0786 * 0.998) {
        return { label, valid: true, ok: false, score: -1.5, zone: "ROTTO_0.786", fib };
    }
    if (livePrice >= fib.fib0236) {
        return { label, valid: true, ok: true, score: 1.0, zone: "0.0-0.236", fib };
    }
    if (livePrice >= fib.fib0382) {
        return { label, valid: true, ok: true, score: holdingOrRising ? 1.2 : 0.4, zone: "0.382", fib };
    }
    if (livePrice >= fib.fib0500) {
        return { label, valid: true, ok: true, score: holdingOrRising ? 1.3 : 0.2, zone: "0.50", fib };
    }
    if (livePrice >= fib.fib0618) {
        return { label, valid: true, ok: holdingOrRising, score: holdingOrRising ? 1.5 : -0.5, zone: "0.618", fib };
    }
    return { label, valid: true, ok: holdingOrRising, score: holdingOrRising ? 0.3 : -1.0, zone: "0.618-0.786", fib };
}

// TERMOMETRO BTC: Fibonacci multi-timeframe (24h, 4h, 1h, 15m, 5m) + valutazione forza/debolezza BTC
async function evaluateBtcMultiTimeframeFibo() {
    try {
        const ticker = await exchange.fetchTicker('BTC/EUR');
        const livePrice = ticker.last;
        if (global.lastBtcLivePrice && livePrice < global.lastBtcLivePrice * 0.988) {
            console.log(`[BTC CROLLO IMPROVVISO] BTC da €${global.lastBtcLivePrice} a €${livePrice}`);
            return {
                allowAltBuys: false,
                btcStrong: false,
                regime: "CRASH_LIVE",
                fibScore: -5,
                summary: `Crollo live BTC a €${livePrice.toFixed(0)}`
            };
        }
        global.lastBtcLivePrice = livePrice;

        const [ohlcv1h, ohlcv15m, ohlcv5m] = await Promise.all([
            exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 30),
            exchange.fetchOHLCV('BTC/EUR', '15m', undefined, 24),
            exchange.fetchOHLCV('BTC/EUR', '5m', undefined, 24)
        ]);

        if (!ohlcv1h || ohlcv1h.length < 24 || !ohlcv15m || ohlcv15m.length < 12 || !ohlcv5m || ohlcv5m.length < 12) {
            return { allowAltBuys: false, btcStrong: false, regime: "NO_DATA", fibScore: 0, summary: "Dati multi-timeframe BTC insufficienti" };
        }

        const fib24h = evaluateSingleTimeframeFibo(ohlcv1h, 24, livePrice, "24h");
        const fib4h = evaluateSingleTimeframeFibo(ohlcv15m, 16, livePrice, "4h");
        const fib1h = evaluateSingleTimeframeFibo(ohlcv15m, 4, livePrice, "1h");
        const fib15m = evaluateSingleTimeframeFibo(ohlcv5m, 3, livePrice, "15m");
        const fib5m = evaluateSingleTimeframeFibo(ohlcv5m, 2, livePrice, "5m");

        const allFibs = [fib24h, fib4h, fib1h, fib15m, fib5m];
        const totalFibScore = allFibs.reduce((sum, f) => sum + f.score, 0);
        const macroStructureOk = fib24h.ok && fib4h.ok;
        const shortTermNotCrashing = fib1h.ok || fib15m.ok;

        const last1h = ohlcv1h[ohlcv1h.length - 1];
        const prev1h = ohlcv1h[ohlcv1h.length - 2];
        const sharpHourlyDump = ((last1h[4] - prev1h[1]) / prev1h[1]) * 100 < -1.1;

        const closes15m = ohlcv15m.map(c => c[4]);
        const ema9_15m = calculateEMA(closes15m, 9);
        const ema21_15m = calculateEMA(closes15m, 21);
        const btcStrong = macroStructureOk && !sharpHourlyDump && totalFibScore >= 2.2 && (!ema9_15m || !ema21_15m || livePrice >= ema21_15m * 0.999);

        const allowAltBuys = macroStructureOk && shortTermNotCrashing && !sharpHourlyDump && totalFibScore >= 0.5;
        const regime = btcStrong ? "FIBO_FORTE" : (allowAltBuys ? "FIBO_ALLINEATO" : "FIBO_DEBOLE_O_ROTTURA");

        const fibDetails = allFibs.map(f => `${f.label}:${f.zone}`).join(" | ");
        const summary = `${regime} | BTC €${livePrice.toFixed(0)} | ScoreFib:${totalFibScore.toFixed(1)} | ${fibDetails}`;
        console.log(`[Termometro BTC Multi-Fib] ${allowAltBuys ? 'OK' : 'STOP'} | ${summary}`);

        return {
            allowAltBuys,
            btcStrong,
            regime,
            fibScore: totalFibScore,
            summary
        };
    } catch (e) {
        console.log(`[Termometro BTC Multi-Fib] Errore: ${e.message}`);
        return { allowAltBuys: false, btcStrong: false, regime: "ERRORE", fibScore: 0, summary: "Errore dati BTC" };
    }
}

// CONFRONTO DIRETTO TRA SEGNALE MACRO E STATO DI BTC:
// - Se la macro è sballata e BTC NON tiene / non è allineato -> BLOCCA nuovi acquisti e alza allarme
// - Se la macro è sballata ma BTC va / regge bene -> NON blocca ciecamente; se BTC è forte lascia andare, se è solo allineato chiede più conferma
function evaluateMacroVsBtcConfrontation(macroStatus, btcRegime) {
    if (!macroStatus.triggered) {
        return {
            blockNewBuys: false,
            protectTighter: false,
            minScoreAdjustment: 0,
            statusLabel: "MACRO_OK",
            reason: "Nessuno scossone macro rilevato"
        };
    }

    if (btcRegime.regime === "CRASH_LIVE" || !btcRegime.allowAltBuys) {
        return {
            blockNewBuys: true,
            protectTighter: true,
            minScoreAdjustment: 1.5,
            statusLabel: "MACRO_E_BTC_DEBOLI_BLOCCO",
            reason: `${macroStatus.reason} + BTC non regge (${btcRegime.summary})`
        };
    }

    if (btcRegime.btcStrong) {
        return {
            blockNewBuys: false,
            protectTighter: false,
            minScoreAdjustment: 0.0,
            statusLabel: "MACRO_SBALLATA_MA_BTC_VA",
            reason: `${macroStatus.reason} ma BTC è forte e tiene (${btcRegime.summary}) -> operatività aperta`
        };
    }

    return {
        blockNewBuys: false,
        protectTighter: true,
        minScoreAdjustment: 0.75,
        statusLabel: "MACRO_SBALLATA_BTC_CAUTO",
        reason: `${macroStatus.reason} con BTC solo allineato (${btcRegime.summary}) -> filtro più selettivo`
    };
}

// VALUTA DINAMICAMENTE SE UNA POSIZIONE APERTA (INCLUSA BTC/EUR) È IN SPINTA O INCERTA / SOTTO ALLARME
function evaluateOpenPositionDynamicHealth(ohlcv5m, ohlcv15m, ohlcv30m, currentPrice, profitPercentage, peakProfitPct, btcRegime, protectTighter) {
    if (!ohlcv5m || ohlcv5m.length < 15 || !ohlcv15m || ohlcv15m.length < 15) {
        return {
            state: protectTighter ? "CAUTO_MACRO_BTC" : "INCERTO",
            dynamicTpGrossPct: UNCERTAIN_ASSET_TP_GROSS_PCT,
            shouldTakeUncertainProfit: false,
            reason: "Dati ridotti -> TP prudente"
        };
    }

    const closes5m = ohlcv5m.map(c => c[4]);
    const lows5m = ohlcv5m.map(c => c[3]);
    const highs5m = ohlcv5m.map(c => c[2]);

    const closes15m = ohlcv15m.map(c => c[4]);
    const highs15m = ohlcv15m.map(c => c[2]);

    const closes30m = (ohlcv30m && ohlcv30m.length >= 12) ? ohlcv30m.map(c => c[4]) : closes15m;

    const ema9_5m = calculateEMA(closes5m, 9);
    const ema21_5m = calculateEMA(closes5m, 21);
    const ema9_15m = calculateEMA(closes15m, 9);
    const ema21_15m = calculateEMA(closes15m, 21);

    const rsi5m = calculateRSI(closes5m, 14);
    const rsi15m = calculateRSI(closes15m, 14);

    const last5m = ohlcv5m[ohlcv5m.length - 1];
    const prev5m = ohlcv5m[ohlcv5m.length - 2];
    const last15m = ohlcv15m[ohlcv15m.length - 1];

    const last5mRed = last5m[4] < last5m[1];
    const prev5mRed = prev5m[4] < prev5m[1];
    const twoRed5m = last5mRed && prev5mRed;
    const pullingBackFromPeak = peakProfitPct > profitPercentage + 0.20;

    const localHigh15m = Math.max(...highs15m.slice(-10, -1));
    const roomToLocalHighPct = currentPrice > 0 ? ((localHigh15m - currentPrice) / currentPrice) * 100 : 0;

    let strengthPoints = 0;
    let uncertaintyPoints = protectTighter ? 1.25 : 0;
    const notes = [];

    if (protectTighter) {
        notes.push("guardia macro/BTC");
    }

    if (ema9_5m && ema21_5m && currentPrice >= ema9_5m && ema9_5m >= ema21_5m * 0.999) {
        strengthPoints += 1.5;
        notes.push("EMA5m allineate");
    } else if (ema21_5m && currentPrice < ema21_5m) {
        uncertaintyPoints += 1.5;
        notes.push("sotto EMA21 5m");
    }

    if (ema9_15m && ema21_15m && currentPrice >= ema9_15m && ema9_15m >= ema21_15m * 0.998) {
        strengthPoints += 1.5;
        notes.push("trend 15m solido");
    } else if (ema21_15m && currentPrice < ema21_15m) {
        uncertaintyPoints += 1.5;
        notes.push("sotto EMA21 15m");
    }

    if (rsi5m >= 52 && rsi5m <= 74 && rsi15m >= 50) {
        strengthPoints += 1.0;
        notes.push(`RSI ${rsi5m.toFixed(0)}/${rsi15m.toFixed(0)}`);
    } else if (rsi15m < 44 || rsi5m < 42) {
        uncertaintyPoints += 1.25;
        notes.push(`RSI debole ${rsi5m.toFixed(0)}/${rsi15m.toFixed(0)}`);
    }

    if (!last5mRed && last15m[4] >= last15m[1]) {
        strengthPoints += 0.75;
        notes.push("candele verdi");
    } else if (twoRed5m) {
        uncertaintyPoints += 1.25;
        notes.push("2 rosse 5m");
    }

    if (roomToLocalHighPct > 0 && roomToLocalHighPct < 0.85 && profitPercentage > 0.5) {
        uncertaintyPoints += 1.0;
        notes.push(`resistenza vicina (+${roomToLocalHighPct.toFixed(1)}%)`);
    }

    const recentLow5m = Math.min(...lows5m.slice(-8, -1));
    if (currentPrice < recentLow5m * 0.998 && closes30m[closes30m.length - 1] < closes30m[closes30m.length - 2]) {
        uncertaintyPoints += 1.0;
        notes.push("rottura micro-supporto");
    }

    let state = "NEUTRO";
    let dynamicTpGrossPct = STANDARD_TP_GROSS_PCT;

    if (uncertaintyPoints >= 2.25 || (uncertaintyPoints > strengthPoints && profitPercentage > 0)) {
        state = protectTighter ? "CAUTO_MACRO_BTC" : "INCERTO";
        dynamicTpGrossPct = UNCERTAIN_ASSET_TP_GROSS_PCT;
    } else if (!protectTighter && strengthPoints >= 3.25 && uncertaintyPoints <= 0.75 && roomToLocalHighPct >= 1.2) {
        state = "IN_SPINTA";
        dynamicTpGrossPct = STRONG_TREND_TP_GROSS_PCT;
    } else {
        state = protectTighter ? "CAUTO_MACRO_BTC" : "NEUTRO";
        dynamicTpGrossPct = protectTighter ? Math.min(STANDARD_TP_GROSS_PCT, 1.30) : STANDARD_TP_GROSS_PCT;
    }

    const shouldTakeUncertainProfit =
        (state === "INCERTO" || state === "CAUTO_MACRO_BTC") &&
        profitPercentage >= UNCERTAIN_FAST_PROFIT_GROSS_PCT &&
        (twoRed5m || pullingBackFromPeak || (ema9_5m && currentPrice < ema9_5m) || (protectTighter && !btcRegime?.btcStrong));

    return {
        state,
        dynamicTpGrossPct,
        shouldTakeUncertainProfit,
        reason: notes.slice(0, 3).join(", ") || state
    };
}

// ================= ORDER BOOK & ORDINI LIMITE =================

async function evaluateOrderBookForExecution(symbol, side = 'buy') {
    try {
        const book = await exchange.fetchOrderBook(symbol, 15);
        const bids = Array.isArray(book?.bids) ? book.bids : [];
        const asks = Array.isArray(book?.asks) ? book.asks : [];

        if (bids.length === 0 || asks.length === 0) {
            return { ok: false, reason: "Book vuoto (bid/ask assenti)" };
        }

        const bestBid = bids[0][0];
        const bestAsk = asks[0][0];
        if (!bestBid || !bestAsk || bestBid <= 0 || bestAsk <= 0 || bestAsk < bestBid) {
            return { ok: false, reason: "Prezzi bid/ask non validi" };
        }

        const midPrice = (bestBid + bestAsk) / 2;
        const spreadPct = ((bestAsk - bestBid) / midPrice) * 100;

        if (spreadPct > MAX_ALLOWED_SPREAD_PCT) {
            return { ok: false, bestBid, bestAsk, spreadPct, reason: `Spread largo (${spreadPct.toFixed(2)}% > ${MAX_ALLOWED_SPREAD_PCT}%)` };
        }

        const levelsToCheck = side === 'buy' ? asks.slice(0, 10) : bids.slice(0, 10);
        let depthEur = 0;
        for (const lvl of levelsToCheck) {
            const price = lvl[0];
            const size = lvl[1];
            if (typeof price === 'number' && typeof size === 'number' && price > 0 && size > 0) {
                depthEur += price * size;
            }
        }

        if (depthEur < MIN_BOOK_DEPTH_EUR) {
            return { ok: false, bestBid, bestAsk, spreadPct, depthEur, reason: `Profondità book bassa lato ${side} (€${depthEur.toFixed(0)} < €${MIN_BOOK_DEPTH_EUR})` };
        }

        return { ok: true, bestBid, bestAsk, spreadPct, depthEur, reason: `Book OK (spread ${spreadPct.toFixed(2)}%, prof ${side} €${depthEur.toFixed(0)})` };
    } catch (e) {
        return { ok: false, reason: `Errore lettura book: ${e.message}` };
    }
}

async function placeTimedLimitBuyOnBook(symbol, amountToBuy, bookInfo) {
    const rawLimitPrice = bookInfo && bookInfo.bestBid ? bookInfo.bestBid : 0;
    if (!rawLimitPrice || rawLimitPrice <= 0) {
        return { filled: false, reason: "Prezzo bid non disponibile" };
    }

    const formattedPrice = Number(exchange.priceToPrecision(symbol, rawLimitPrice));
    const formattedAmount = Number(exchange.amountToPrecision(symbol, amountToBuy));

    if (!formattedPrice || !formattedAmount || formattedAmount <= 0) {
        return { filled: false, reason: "Quantità/prezzo non formattabili" };
    }

    const order = await exchange.createLimitBuyOrder(symbol, formattedAmount, formattedPrice);
    const orderId = order?.id;
    console.log(`[LIMIT BUY INVIATO] ${symbol}: ${formattedAmount} @ €${formattedPrice} (ID: ${orderId || 'N/D'})`);

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
                console.log(`[LIMIT IN RITARDO] ${symbol} salito a €${ticker.last} oltre limite €${formattedPrice}, cancello ordine.`);
                break;
            }
        } catch (pollErr) {
            console.log(`[Poll Ordine Limite ${symbol}]: ${pollErr.message}`);
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
        console.log(`[Cancel Ordine Limite ${symbol}]: ${cancelErr.message}`);
    }

    return { filled: false, reason: `Ordine limite non eseguito entro ${Math.round(LIMIT_FILL_TIMEOUT_MS / 1000)}s (annullato)` };
}

// ================= MACRO & GEOPOLITICA (LUN-VEN 15:00-22:30) =================

async function fetchYahooDailyChangePct(tickerSymbol) {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tickerSymbol)}?range=2d&interval=15m`;
        const res = await axios.get(url, { timeout: 4500, headers: { 'User-Agent': 'Mozilla/5.0' } });
        const meta = res.data?.chart?.result?.[0]?.meta;
        if (!meta) return null;
        const currentPrice = meta.regularMarketPrice;
        const prevClose = meta.chartPreviousClose || meta.previousClose;
        if (typeof currentPrice === 'number' && typeof prevClose === 'number' && prevClose > 0) {
            return ((currentPrice - prevClose) / prevClose) * 100;
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function evaluateMacroAndGeopolitics() {
    const dayInfo = getItalyDayAndMinutes();
    if (!dayInfo.isUsMarketSession) {
        macroLockedUntil = 0;
        return { triggered: false, reason: "Mercati USA chiusi" };
    }

    if (Date.now() < macroLockedUntil) {
        const remMin = Math.max(1, Math.ceil((macroLockedUntil - Date.now()) / 60000));
        return { triggered: true, reason: `Segnale macro/geo attivo (~${remMin}m)` };
    }

    const [nasdaqPct, sp500Pct, oilPct] = await Promise.all([
        fetchYahooDailyChangePct('^IXIC'),
        fetchYahooDailyChangePct('^GSPC'),
        fetchYahooDailyChangePct('CL=F')
    ]);

    if (typeof nasdaqPct === 'number' && nasdaqPct < MACRO_INDEX_MAX_DROP_PCT) {
        macroLockedUntil = Date.now() + MACRO_LOCK_DURATION_MS;
        return { triggered: true, reason: `Nasdaq ${nasdaqPct.toFixed(2)}%` };
    }
    if (typeof sp500Pct === 'number' && sp500Pct < MACRO_INDEX_MAX_DROP_PCT) {
        macroLockedUntil = Date.now() + MACRO_LOCK_DURATION_MS;
        return { triggered: true, reason: `S&P 500 ${sp500Pct.toFixed(2)}%` };
    }
    if (typeof oilPct === 'number' && oilPct > OIL_SHOCK_MAX_SPIKE_PCT) {
        macroLockedUntil = Date.now() + MACRO_LOCK_DURATION_MS;
        return { triggered: true, reason: `Petrolio +${oilPct.toFixed(2)}%` };
    }

    return { triggered: false, reason: "OK" };
}

// ================= ANALISI SUPPORTI (5m, 15m, 30m) + EMA + RSI + BOLLINGER + VOLUMI + GAINERS/LOSERS =================

function evaluateMultiSupportAndIndicatorsSetup(ohlcv5m, ohlcv15m, ohlcv30m, isWinner, isLoser, minScoreRequired = MIN_TECHNICAL_ENTRY_SCORE) {
    if (!ohlcv5m || ohlcv5m.length < 25 || !ohlcv15m || ohlcv15m.length < 25 || !ohlcv30m || ohlcv30m.length < 20) {
        return { valid: false, score: 0, reason: "Dati multi-timeframe insufficienti" };
    }

    const closes5m = ohlcv5m.map(c => c[4]);
    const lows5m = ohlcv5m.map(c => c[3]);
    const vols5m = ohlcv5m.map(c => c[5]);

    const closes15m = ohlcv15m.map(c => c[4]);
    const lows15m = ohlcv15m.map(c => c[3]);

    const closes30m = ohlcv30m.map(c => c[4]);
    const lows30m = ohlcv30m.map(c => c[3]);
    const highs30m = ohlcv30m.map(c => c[2]);

    const currentPrice = closes5m[closes5m.length - 1];
    const prevClose5m = closes5m[closes5m.length - 2];

    const support5m = Math.min(...lows5m.slice(-16, -1));
    const support15m = Math.min(...lows15m.slice(-16, -1));
    const support30m = Math.min(...lows30m.slice(-16, -1));

    const distSup5mPct = support5m > 0 ? ((currentPrice - support5m) / support5m) * 100 : 99;
    const distSup15mPct = support15m > 0 ? ((currentPrice - support15m) / support15m) * 100 : 99;
    const distSup30mPct = support30m > 0 ? ((currentPrice - support30m) / support30m) * 100 : 99;

    const notBreakingSupports = currentPrice >= support5m * 0.998 && currentPrice >= support15m * 0.997;
    const nearSupport5m = distSup5mPct >= 0 && distSup5mPct <= 0.75;
    const nearSupport15m = distSup15mPct >= 0 && distSup15mPct <= 1.15;
    const nearSupport30m = distSup30mPct >= 0 && distSup30mPct <= 1.50;

    const ema9_5m = calculateEMA(closes5m, 9);
    const ema21_5m = calculateEMA(closes5m, 21);
    const ema9_15m = calculateEMA(closes15m, 9);
    const ema21_15m = calculateEMA(closes15m, 21);

    const rsi5m = calculateRSI(closes5m, 14);
    const rsi15m = calculateRSI(closes15m, 14);

    const bb5m = calculateBollingerBands(closes5m, 20, 2);
    const bb15m = calculateBollingerBands(closes15m, 20, 2);

    const localRes30m = Math.max(...highs30m.slice(-12));
    const roomToResPct = currentPrice > 0 ? ((localRes30m - currentPrice) / currentPrice) * 100 : 0;

    const avgVol5m = vols5m.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
    const lastCandle5m = ohlcv5m[ohlcv5m.length - 1];
    const prevCandle5m = ohlcv5m[ohlcv5m.length - 2];
    const volCtx = interpretVolumeContext(lastCandle5m, prevCandle5m, avgVol5m);

    let score = 0;
    const reasons = [];

    if (nearSupport5m) {
        score += 1.5;
        reasons.push(`Sup 5m (€${support5m})`);
    }
    if (nearSupport15m) {
        score += 1.5;
        reasons.push(`Sup 15m (€${support15m})`);
    }
    if (nearSupport30m) {
        score += 1.0;
        reasons.push(`Sup 30m (€${support30m})`);
    }

    if (rsi5m >= 28 && rsi5m <= 54 && currentPrice >= prevClose5m) {
        score += 1.75;
        reasons.push(`RSI 5m ${rsi5m.toFixed(0)}`);
    } else if (rsi5m > 68 || rsi15m > 70) {
        score -= 2.5;
        reasons.push(`RSI tirato (${rsi5m.toFixed(0)}/${rsi15m.toFixed(0)})`);
    }

    if (rsi15m >= 32 && rsi15m <= 58) {
        score += 1.0;
        reasons.push(`RSI 15m ${rsi15m.toFixed(0)}`);
    }

    if (ema9_5m && ema21_5m && currentPrice >= ema9_5m && ema9_5m >= ema21_5m * 0.998) {
        score += 1.5;
        reasons.push("EMA9>EMA21 5m");
    } else if (ema9_5m && currentPrice > ema9_5m && currentPrice >= prevClose5m) {
        score += 1.0;
        reasons.push("Recupero EMA9 5m");
    }

    if (ema9_15m && ema21_15m && ema9_15m >= ema21_15m * 0.997) {
        score += 0.75;
        reasons.push("EMA 15m OK");
    }

    if (bb5m && currentPrice <= bb5m.middle && currentPrice >= bb5m.lower * 0.997 && currentPrice >= prevClose5m) {
        score += 1.25;
        reasons.push("Rimbalzo BB 5m");
    }
    if (bb15m && currentPrice <= bb15m.middle && currentPrice >= bb15m.lower * 0.997) {
        score += 0.75;
        reasons.push("Zona bassa BB 15m");
    }

    score += volCtx.scoreDelta;
    reasons.push(volCtx.label);

    if (isWinner) {
        score += 1.0;
        reasons.push("Top Gainer");
    } else if (isLoser && (nearSupport15m || nearSupport30m) && rsi5m <= 48 && currentPrice >= prevClose5m) {
        score += 1.25;
        reasons.push("Top Loser su supporto");
    }

    if (roomToResPct < 1.15) {
        score -= 1.5;
        reasons.push(`Resistenza vicina (+${roomToResPct.toFixed(1)}%)`);
    }

    const hasSupportConfluence = nearSupport5m || nearSupport15m || nearSupport30m;
    const valid = notBreakingSupports && hasSupportConfluence && volCtx.allowLowVolMove && score >= minScoreRequired && currentPrice >= prevClose5m;

    return {
        valid,
        score,
        reason: reasons.join(" + ") || "Nessuna confluenza tecnica"
    };
}

// ================= CICLO PRINCIPALE DEL BOT =================

async function runBotLoop() {
    while (true) {
        try {
            if (botRunning) {
                const now = new Date().toLocaleString();
                await exchange.loadMarkets();

                const balance = await exchange.fetchBalance();
                const eurBalance = balance.free['EUR'] || balance.free['ZEUR'] || 0;
                console.log(`[${now}] Saldo EUR: €${eurBalance.toFixed(2)}`);

                const macroStatus = await evaluateMacroAndGeopolitics();
                const btcRegime = await evaluateBtcMultiTimeframeFibo();
                const macroVsBtc = evaluateMacroVsBtcConfrontation(macroStatus, btcRegime);

                console.log(`[Confronto Macro <-> BTC] ${macroVsBtc.statusLabel} | ${macroVsBtc.reason}`);

                const totalBalances = balance.total || {};
                const assetKeys = Object.keys(totalBalances).filter(rawCurrency => {
                    if (stablecoinsToIgnore.includes(rawCurrency)) return false;
                    const amt = totalBalances[rawCurrency] || 0;
                    if (amt <= MIN_COIN_AMOUNT_FLOOR) return false;
                    let clean = rawCurrency.replace(/^[XZ]/, '');
                    if (clean === 'XBT') clean = 'BTC';
                    return !stablecoinsToIgnore.includes(clean);
                });

                // 1. GESTIONE POSIZIONI APERTE (INCLUSA BTC/EUR)
                const trackedSymbolsSet = new Set();

                for (const rawCurrency of assetKeys) {
                    let cleanCurrency = rawCurrency.replace(/^[XZ]/, '');
                    if (cleanCurrency === 'XBT') cleanCurrency = 'BTC';

                    let symbol = `${cleanCurrency}/EUR`;
                    if (!exchange.markets[symbol]) {
                        symbol = `${rawCurrency}/EUR`;
                        if (!exchange.markets[symbol]) continue;
                    }

                    try {
                        const totalAmt = totalBalances[rawCurrency] || 0;
                        const freeCoinAmount = balance.free[rawCurrency] || balance.free[cleanCurrency] || balance.free[`X${cleanCurrency}`] || balance.free[`Z${cleanCurrency}`] || 0;

                        const ticker = await exchange.fetchTicker(symbol);
                        const currentPrice = ticker.last;

                        if (!isMeaningfulHolding(totalAmt, currentPrice)
