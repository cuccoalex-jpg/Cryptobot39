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
let lastLog = "Bot Volatilità avviato: ATR% + Squeeze/Espansione Bollinger + Impulsi 5m/15m + Uscite Dinamiche (10€).";
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

// Parametri Operativi (tempo illimitato fino a TP dinamico, trailing o Stop Loss / Fast Cut)
const ORDER_SIZE_EUR = 10;
const MIN_TRACKED_POSITION_EUR = 1.50;
const MIN_COIN_AMOUNT_FLOOR = 0.002;

// Soglie di Volatilità (ATR% e larghezza Bande di Bollinger)
const MIN_ATR_PCT_5M = 0.45;                 // Volatilità minima 5m richiesta per considerare l'asset "vivo"
const HIGH_VOLATILITY_ATR_PCT = 1.35;          // Fase di alta volatilità: uscite più pronte per non farsi riprendere lo spike
const VOLATILE_TP_MIN_GROSS_PCT = 0.90;        // TP rapido in volatilità incerta/esplosiva
const VOLATILE_TP_BASE_GROSS_PCT = 1.55;       // TP standard su volatilità ordinata
const VOLATILE_TP_MAX_GROSS_PCT = 2.60;        // TP esteso se l'impulso è forte e pulito

// Protezione trailing e Stop Loss / Fast Cut su movimenti rapidi
const TRAILING_ARM_GROSS_PCT = 0.95;          // Arma il trailing presto per proteggere gli spike volatili
const TRAILING_FLOOR_GROSS_PCT = 0.58;        // Margine minimo protetto sopra le fee
const TRAILING_PULLBACK_VOLATILE_PCT = 0.28;   // Ritracciamento stretto dal picco in alta volatilità
const TRAILING_PULLBACK_NORMAL_PCT = 0.38;     // Ritracciamento standard dal picco
const STOP_LOSS_FAST_CUT_PCT = -1.35;         // Stop loss / fast cut di invalidazione

// Order Book: controllo spread, profondità e ordine limite rapido sull'ingresso
const MAX_ALLOWED_SPREAD_PCT = 0.55;          // Leggermente tollerante per coin volatili, ma blocca book vuoti/buchi enormi
const MIN_BOOK_DEPTH_EUR = 150;
const LIMIT_FILL_TIMEOUT_MS = 18000;          // Attesa rapida (18s) per non rincorrere spike già partiti o finiti
const LIMIT_POLL_INTERVAL_MS = 3000;

// Ritmo ingressi
const MIN_VOLATILITY_ENTRY_SCORE = 5.5;
const BUY_COOLDOWN_MS = 4 * 60 * 1000;        // 4 minuti tra ingressi per cogliere le onde volatili
const SYMBOL_STOP_COOLDOWN_MS = 25 * 60 * 1000;

// Macro & Geopolitica (solo mercati USA aperti lun-ven 15:00-22:30 ora italiana)
const MACRO_INDEX_MAX_DROP_PCT = -1.2;
const OIL_SHOCK_MAX_SPIKE_PCT = 3.5;
const MACRO_LOCK_DURATION_MS = 15 * 60 * 1000;

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 - Volatilità</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 (Modalità Volatilità) - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>ATR% 5m Min:</b> ${MIN_ATR_PCT_5M}% | <b>TP Dinamico:</b> +${VOLATILE_TP_MIN_GROSS_PCT}% / +${VOLATILE_TP_BASE_GROSS_PCT}% / +${VOLATILE_TP_MAX_GROSS_PCT}% | <b>Stop/Fast Cut:</b> ${STOP_LOSS_FAST_CUT_PCT}%</p>
                <p><b>Posizioni Attive (>= €${MIN_TRACKED_POSITION_EUR}):</b> ${Object.keys(activePositions).length > 0 ? Object.keys(activePositions).join(', ') : 'Nessuna'}</p>
                <p><b>Watchlist Attiva:</b> ${focusedHotPool.length > 0 ? focusedHotPool.join(', ') : 'Sincronizzazione in corso...'}</p>
            </body>
        </html>
    `);
});

app.post('/api/toggle', (req, res) => {
    botRunning = !botRunning;
    lastLog = `Bot Volatilità ${botRunning ? 'riattivato' : 'messo in pausa'} via API.`;
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

// ================= INDICATORI TECNICI & VOLATILITÀ (ATR%, BOLLINGER, RSI, EMA, FIBO) =================

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
    const bandwidthPct = mean > 0 ? ((upperOrWidth(mean, stdMult, stdDev)) / mean) * 100 : 0;
    return {
        middle: mean,
        upper: mean + stdMult * stdDev,
        lower: mean - stdMult * stdDev,
        bandwidthPct
    };
}

function upperOrWidth(mean, stdMult, stdDev) {
    return (mean + stdMult * stdDev) - (mean - stdMult * stdDev);
}

// Calcola ATR% medio e ultimo range percentuale delle candele per misurare la volatilità reale
function calculateVolatilityMetrics(ohlcv, period = 14) {
    if (!ohlcv || ohlcv.length < period + 2) {
        return { atrPct: 0, lastRangePct: 0, prevAvgRangePct: 0, expanding: false };
    }

    const trs = [];
    for (let i = 1; i < ohlcv.length; i++) {
        const high = ohlcv[i][2];
        const low = ohlcv[i][3];
        const prevClose = ohlcv[i - 1][4];
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
        trs.push(tr);
    }

    const recentTrs = trs.slice(-period);
    const atr = recentTrs.reduce((a, b) => a + b, 0) / recentTrs.length;
    const lastCandle = ohlcv[ohlcv.length - 1];
    const prevCandle = ohlcv[ohlcv.length - 2];
    const lastPrice = lastCandle[4] || 1;

    const atrPct = lastPrice > 0 ? (atr / lastPrice) * 100 : 0;
    const lastRangePct = lastCandle[3] > 0 ? ((lastCandle[2] - lastCandle[3]) / lastCandle[3]) * 100 : 0;

    const earlierSlice = ohlcv.slice(-period - 5, -2);
    const earlierRangesPct = earlierSlice
        .filter(c => c[3] > 0)
        .map(c => ((c[2] - c[3]) / c[3]) * 100);
    const prevAvgRangePct = earlierRangesPct.length > 0
        ? earlierRangesPct.reduce((a, b) => a + b, 0) / earlierRangesPct.length
        : lastRangePct;

    const expanding = lastRangePct > prevAvgRangePct * 1.25 || (prevCandle[3] > 0 && ((prevCandle[2] - prevCandle[3]) / prevCandle[3]) * 100 > prevAvgRangePct * 1.25);

    return { atrPct, lastRangePct, prevAvgRangePct, expanding };
}

function interpretVolatilityVolume(lastCandle, prevCandle, avgVol) {
    if (!lastCandle || !avgVol || avgVol <= 0) {
        return { label: "VOL_ND", scoreDelta: 0, toxicDump: false };
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

    // Scarico violento con volumi alti su candela rossa
    if (!isGreen && ratio >= 1.25 && close < (prevCandle ? prevCandle[4] : open)) {
        return { label: `SCARICO(${ratio.toFixed(1)}x)`, scoreDelta: -2.0, toxicDump: true };
    }
    // Spike con lunga ombra superiore: rischio finta rottura / respinta immediata
    if (ratio >= 2.2 && upperWickRatio >= 0.50) {
        return { label: `WICK_SPIKE(${ratio.toFixed(1)}x)`, scoreDelta: -0.8, toxicDump: false };
    }
    // Volumi in espansione su candela verde: conferma della volatilità direzionale
    if (isGreen && ratio >= 1.2) {
        return { label: `VOL_IMPULSO(${ratio.toFixed(1)}x)`, scoreDelta: 1.25, toxicDump: false };
    }
    // Anche con volume basso, se la candela è verde e ordinata, non blocca
    if (isGreen && ratio < 0.8) {
        return { label: `VOL_LEGGERO_OK(${ratio.toFixed(1)}x)`, scoreDelta: 0.25, toxicDump: false };
    }
    return { label: `VOL(${ratio.toFixed(1)}x)`, scoreDelta: isGreen ? 0.5 : -0.25, toxicDump: false };
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
    if (livePrice >= fib.fib0382) {
        return { label, valid: true, ok: true, score: holdingOrRising ? 1.2 : 0.4, zone: livePrice >= fib.fib0236 ? "0.0-0.236" : "0.382", fib };
    }
    if (livePrice >= fib.fib0618) {
        return { label, valid: true, ok: holdingOrRising, score: holdingOrRising ? 1.3 : -0.4, zone: livePrice >= fib.fib0500 ? "0.50" : "0.618", fib };
    }
    return { label, valid: true, ok: holdingOrRising, score: holdingOrRising ? 0.3 : -1.0, zone: "0.618-0.786", fib };
}

// TERMOMETRO BTC: Fibonacci multi-timeframe + controllo strappi/crolli
async function evaluateBtcVolatilityRegime() {
    try {
        const ticker = await exchange.fetchTicker('BTC/EUR');
        const livePrice = ticker.last;
        if (global.lastBtcLivePrice && livePrice < global.lastBtcLivePrice * 0.988) {
            console.log(`[BTC CROLLO IMPROVVISO] BTC da €${global.lastBtcLivePrice} a €${livePrice}`);
            return { allowAltBuys: false, regime: "CRASH_LIVE", fibScore: -5, summary: `Crollo live BTC a €${livePrice.toFixed(0)}` };
        }
        global.lastBtcLivePrice = livePrice;

        const [ohlcv1h, ohlcv15m, ohlcv5m] = await Promise.all([
            exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 30),
            exchange.fetchOHLCV('BTC/EUR', '15m', undefined, 24),
            exchange.fetchOHLCV('BTC/EUR', '5m', undefined, 24)
        ]);

        if (!ohlcv1h || ohlcv1h.length < 24 || !ohlcv15m || ohlcv15m.length < 12 || !ohlcv5m || ohlcv5m.length < 12) {
            return { allowAltBuys: false, regime: "NO_DATA", fibScore: 0, summary: "Dati BTC insufficienti" };
        }

        const fib24h = evaluateSingleTimeframeFibo(ohlcv1h, 24, livePrice, "24h");
        const fib4h = evaluateSingleTimeframeFibo(ohlcv15m, 16, livePrice, "4h");
        const fib1h = evaluateSingleTimeframeFibo(ohlcv15m, 4, livePrice, "1h");
        const fib15m = evaluateSingleTimeframeFibo(ohlcv5m, 3, livePrice, "15m");
        const fib5m = evaluateSingleTimeframeFibo(ohlcv5m, 2, livePrice, "5m");

        const allFibs = [fib24h, fib4h, fib1h, fib15m, fib5m];
        const totalFibScore = allFibs.reduce((sum, f) => sum + f.score, 0);
        const macroStructureOk = fib24h.ok && fib4h.ok;
        const shortTermOk = fib1h.ok || fib15m.ok;

        const last1h = ohlcv1h[ohlcv1h.length - 1];
        const prev1h = ohlcv1h[ohlcv1h.length - 2];
        const sharpHourlyDump = ((last1h[4] - prev1h[1]) / prev1h[1]) * 100 < -1.1;

        const allowAltBuys = macroStructureOk && shortTermOk && !sharpHourlyDump && totalFibScore >= 0.4;
        const regime = allowAltBuys ? "VOL_FIBO_OK" : "VOL_FIBO_STOP";

        const fibDetails = allFibs.map(f => `${f.label}:${f.zone}`).join(" | ");
        const summary = `${regime} | BTC €${livePrice.toFixed(0)} | ScoreFib:${totalFibScore.toFixed(1)} | ${fibDetails}`;
        console.log(`[Termometro BTC Volatilità] ${allowAltBuys ? 'OK' : 'STOP'} | ${summary}`);

        return { allowAltBuys, regime, fibScore: totalFibScore, summary };
    } catch (e) {
        console.log(`[Termometro BTC Volatilità] Errore: ${e.message}`);
        return { allowAltBuys: false, regime: "ERRORE", fibScore: 0, summary: "Errore dati BTC" };
    }
}

// ================= SETUP VOLATILITÀ (5m, 15m, 30m) =================

function evaluateVolatilityEntrySetup(ohlcv5m, ohlcv15m, ohlcv30m, isWinner, isLoser) {
    if (!ohlcv5m || ohlcv5m.length < 25 || !ohlcv15m || ohlcv15m.length < 25 || !ohlcv30m || ohlcv30m.length < 20) {
        return { valid: false, score: 0, mode: "NONE", atrPct5m: 0, reason: "Dati insufficienti" };
    }

    const closes5m = ohlcv5m.map(c => c[4]);
    const highs5m = ohlcv5m.map(c => c[2]);
    const lows5m = ohlcv5m.map(c => c[3]);
    const vols5m = ohlcv5m.map(c => c[5]);

    const closes15m = ohlcv15m.map(c => c[4]);
    const lows15m = ohlcv15m.map(c => c[3]);
    const highs30m = ohlcv30m.map(c => c[2]);
    const lows30m = ohlcv30m.map(c => c[3]);

    const currentPrice = closes5m[closes5m.length - 1];
    const prevClose5m = closes5m[closes5m.length - 2];
    const lastCandle5m = ohlcv5m[ohlcv5m.length - 1];
    const prevCandle5m = ohlcv5m[ohlcv5m.length - 2];

    const vol5m = calculateVolatilityMetrics(ohlcv5m, 14);
    const vol15m = calculateVolatilityMetrics(ohlcv15m, 14);

    // Se la volatilità è troppo bassa, non è una fase volatile sfruttabile
    if (vol5m.atrPct < MIN_ATR_PCT_5M && !vol5m.expanding) {
        return { valid: false, score: 0, mode: "LOW_VOL", atrPct5m: vol5m.atrPct, reason: "Volatilità troppo bassa" };
    }

    const avgVol5m = vols5m.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
    const volCtx = interpretVolatilityVolume(lastCandle5m, prevCandle5m, avgVol5m);
    if (volCtx.toxicDump) {
        return { valid: false, score: -2, mode: "DUMP", atrPct5m: vol5m.atrPct, reason: volCtx.label };
    }

    const bb5m = calculateBollingerBands(closes5m, 20, 2);
    const bb15m = calculateBollingerBands(closes15m, 20, 2);
    const rsi5m = calculateRSI(closes5m, 14);
    const rsi15m = calculateRSI(closes15m, 14);
    const ema9_5m = calculateEMA(closes5m, 9);
    const ema21_5m = calculateEMA(closes5m, 21);

    const support5m = Math.min(...lows5m.slice(-16, -1));
    const support15m = Math.min(...lows15m.slice(-16, -1));
    const support30m = Math.min(...lows30m.slice(-16, -1));
    const recentHigh5m = Math.max(...highs5m.slice(-12, -1));
    const localRes30m = Math.max(...highs30m.slice(-12));

    const notCrashing = currentPrice >= support5m * 0.996 && currentPrice >= support15m * 0.995;
    const roomToResPct = currentPrice > 0 ? ((localRes30m - currentPrice) / currentPrice) * 100 : 0;

    // Due tipi di ingresso nella volatilità:
    // A) Rimbalzo volatile su supporto o banda inferiore di Bollinger con candela che gira verde
    const nearSupport =
        (support5m > 0 && ((currentPrice - support5m) / support5m) * 100 <= 0.95) ||
        (support15m > 0 && ((currentPrice - support15m) / support15m) * 100 <= 1.30) ||
        (support30m > 0 && ((currentPrice - support30m) / support30m) * 100 <= 1.60);
    const volatileBounce = nearSupport && bb5m && currentPrice <= bb5m.middle && currentPrice >= bb5m.lower * 0.995 && currentPrice >= prevClose5m;

    // B) Strappo / rottura volatile di breve con espansione di range e RSI non già in ipercomprato estremo
    const volatileBreakout = vol5m.expanding && currentPrice > recentHigh5m * 0.999 && currentPrice >= prevClose5m && rsi5m <= 68 && rsi15m <= 70;

    if (!notCrashing || (!volatileBounce && !volatileBreakout)) {
        return { valid: false, score: 0, mode: "NO_TRIGGER", atrPct5m: vol5m.atrPct, reason: "Nessun trigger volatile" };
    }

    let score = 0;
    const reasons = [];

    if (volatileBreakout) {
        score += 2.5;
        reasons.push(`Strappo volatile (ATR ${vol5m.atrPct.toFixed(2)}%)`);
    }
    if (volatileBounce) {
        score += 2.5;
        reasons.push(`Rimbalzo volatile su supporto/BB (ATR ${vol5m.atrPct.toFixed(2)}%)`);
    }

    if (vol15m.atrPct >= MIN_ATR_PCT_5M * 1.1) {
        score += 1.0;
        reasons.push(`15m vivo (${vol15m.atrPct.toFixed(2)}%)`);
    }

    if (rsi5m >= 28 && rsi5m <= 64) {
        score += 1.25;
        reasons.push(`RSI5m ${rsi5m.toFixed(0)}`);
    } else if (rsi5m > 72) {
        score -= 2.0;
        reasons.push("RSI5m tirato");
    }

    if (ema9_5m && ema21_5m && currentPrice >= ema9_5m && ema9_5m >= ema21_5m * 0.997) {
        score += 1.25;
        reasons.push("EMA 5m favorevoli");
    }

    if (bb5m && bb5m.bandwidthPct >= 1.2) {
        score += 0.75;
        reasons.push(`Bande aperte ${bb5m.bandwidthPct.toFixed(1)}%`);
    }

    score += volCtx.scoreDelta;
    reasons.push(volCtx.label);

    if (isWinner) {
        score += 1.0;
        reasons.push("Gainer");
    } else if (isLoser && volatileBounce) {
        score += 1.0;
        reasons.push("Loser in rimbalzo");
    }

    if (roomToResPct < 1.05 && !volatileBreakout) {
        score -= 1.5;
        reasons.push(`Spazio limitato (+${roomToResPct.toFixed(1)}%)`);
    }

    const mode = volatileBreakout ? "BREAKOUT_VOL" : "RIMBALZO_VOL";
    const valid = score >= MIN_VOLATILITY_ENTRY_SCORE && currentPrice >= prevClose5m;

    return {
        valid,
        score,
        mode,
        atrPct5m: vol5m.atrPct,
        reason: reasons.join(" + ")
    };
}

// GESTIONE DINAMICA USCITE IN VOLATILITÀ: adatta TP e incasso rapido se la volatilità diventa disordinata/incerta
function evaluateVolatilePositionExit(ohlcv5m, ohlcv15m, profitPercentage, peakProfitPct, btcRegime) {
    const vol5m = calculateVolatilityMetrics(ohlcv5m || [], 14);
    const closes5m = (ohlcv5m && ohlcv5m.length >= 10) ? ohlcv5m.map(c => c[4]) : [];
    const closes15m = (ohlcv15m && ohlcv15m.length >= 10) ? ohlcv15m.map(c => c[4]) : [];

    const last5m = ohlcv5m && ohlcv5m.length >= 2 ? ohlcv5m[ohlcv5m.length - 1] : null;
    const prev5m = ohlcv5m && ohlcv5m.length >= 2 ? ohlcv5m[ohlcv5m.length - 2] : null;

    const ema9_5m = calculateEMA(closes5m, 9);
    const ema21_15m = calculateEMA(closes15m, 21);
    const rsi5m = calculateRSI(closes5m, 14);

    const currentPrice = closes5m.length > 0 ? closes5m[closes5m.length - 1] : 0;
    const twoRed5m = last5m && prev5m && last5m[4] < last5m[1] && prev5m[4] < prev5m[1];
    const pullingBackFromPeak = peakProfitPct > profitPercentage + 0.20;

    const highChaos = vol5m.atrPct >= HIGH_VOLATILITY_ATR_PCT;
    const weakOrUncertain =
        (ema21_15m && currentPrice > 0 && currentPrice < ema21_15m) ||
        (ema9_5m && currentPrice > 0 && currentPrice < ema9_5m && twoRed5m) ||
        !btcRegime.allowAltBuys;

    let dynamicTpGrossPct = VOLATILE_TP_BASE_GROSS_PCT;
    let exitTag = "TP_BASE";

    if (weakOrUncertain || highChaos) {
        // In alta volatilità o incertezza, incassa più in fretta per non farsi riprendere lo strappo
        dynamicTpGrossPct = VOLATILE_TP_MIN_GROSS_PCT;
        exitTag = highChaos ? "TP_ALTA_VOL" : "TP_INCERTO";
    } else if (ema9_5m && currentPrice >= ema9_5m && rsi5m >= 52 && rsi5m <= 74 && !twoRed5m) {
        dynamicTpGrossPct = VOLATILE_TP_MAX_GROSS_PCT;
        exitTag = "TP_SPINTA_VOL";
    }

    // Incasso rapido se è già in buon utile lordo (>= +0.82%) e la volatilità fa segnali di incertezza/ritracciamento
    const quickVolatilityHarvest =
        profitPercentage >= 0.82 &&
        (twoRed5m || pullingBackFromPeak || (ema9_5m && currentPrice > 0 && currentPrice < ema9_5m));

    const pullbackUsed = highChaos ? TRAILING_PULLBACK_VOLATILE_PCT : TRAILING_PULLBACK_NORMAL_PCT;
    let isTrailingHit = false;
    if (peakProfitPct >= TRAILING_ARM_GROSS_PCT) {
        const trailingLevel = Math.max(TRAILING_FLOOR_GROSS_PCT, peakProfitPct - pullbackUsed);
        if (profitPercentage <= trailingLevel) {
            isTrailingHit = true;
        }
    }

    const isTpHit = profitPercentage >= dynamicTpGrossPct;
    const isStopLossHit = profitPercentage <= STOP_LOSS_FAST_CUT_PCT || btcRegime.regime === "CRASH_LIVE";

    return {
        dynamicTpGrossPct,
        exitTag,
        quickVolatilityHarvest,
        isTrailingHit,
        isTpHit,
        isStopLossHit
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
    console.log(`[LIMIT BUY VOL] ${symbol}: ${formattedAmount} @ €${formattedPrice} (ID: ${orderId || 'N/D'})`);

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
            if (ticker && typeof ticker.last === 'number' && ticker.last > formattedPrice * 1.004) {
                console.log(`[LIMIT VOL SCAPPATO] ${symbol} salito a €${ticker.last} oltre €${formattedPrice}, cancello.`);
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

    return { filled: false, reason: `Limite non eseguito entro ${Math.round(LIMIT_FILL_TIMEOUT_MS / 1000)}s` };
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
        return { blocked: false, reason: "Mercati USA chiusi" };
    }

    if (Date.now() < macroLockedUntil) {
        const remMin = Math.max(1, Math.ceil((macroLockedUntil - Date.now()) / 60000));
        return { blocked: true, reason: `Lock macro/geopolitica attivo (~${remMin}m)` };
    }

    const [nasdaqPct, sp500Pct, oilPct] = await Promise.all([
        fetchYahooDailyChangePct('^IXIC'),
        fetchYahooDailyChangePct('^GSPC'),
        fetchYahooDailyChangePct('CL=F')
    ]);

    if (typeof nasdaqPct === 'number' && nasdaqPct < MACRO_INDEX_MAX_DROP_PCT) {
        macroLockedUntil = Date.now() + MACRO_LOCK_DURATION_MS;
        return { blocked: true, reason: `Nasdaq in calo (${nasdaqPct.toFixed(2)}%)` };
    }
    if (typeof sp500Pct === 'number' && sp500Pct < MACRO_INDEX_MAX_DROP_PCT) {
        macroLockedUntil = Date.now() + MACRO_LOCK_DURATION_MS;
        return { blocked: true, reason: `S&P 500 in calo (${sp500Pct.toFixed(2)}%)` };
    }
    if (typeof oilPct === 'number' && oilPct > OIL_SHOCK_MAX_SPIKE_PCT) {
        macroLockedUntil = Date.now() + MACRO_LOCK_DURATION_MS;
        return { blocked: true, reason: `Spike Petrolio (+${oilPct.toFixed(2)}%)` };
    }

    return { blocked: false, reason: "OK" };
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
                if (macroStatus.blocked) {
                    console.log(`[MACRO/GEO BLOCCATO] ${macroStatus.reason}. Nuovi acquisti in pausa.`);
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                const btcRegime = await evaluateBtcVolatilityRegime();

                const totalBalances = balance.total || {};
                const assetKeys = Object.keys(totalBalances).filter(rawCurrency => {
                    if (stablecoinsToIgnore.includes(rawCurrency)) return false;
                    const amt = totalBalances[rawCurrency] || 0;
                    if (amt <= MIN_COIN_AMOUNT_FLOOR) return false;
                    let clean = rawCurrency.replace(/^[XZ]/, '');
                    if (clean === 'XBT') clean = 'BTC';
                    return !stablecoinsToIgnore.includes(clean);
                });

                // 1. GESTIONE POSIZIONI APERTE (Tempo illimitato fino a TP dinamico, incasso rapido su volatilità, trailing o Stop Loss)
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

                        let exitPlan = {
                            dynamicTpGrossPct: VOLATILE_TP_BASE_GROSS_PCT,
                            exitTag: "TP_BASE",
                            quickVolatilityHarvest: false,
                            isTrailingHit: false,
                            isTpHit: profitPercentage >= VOLATILE_TP_BASE_GROSS_PCT,
                            isStopLossHit: profitPercentage <= STOP_LOSS_FAST_CUT_PCT || btcRegime.regime === "CRASH_LIVE"
                        };

                        try {
                            const [p5m, p15m] = await Promise.all([
                                exchange.fetchOHLCV(symbol, '5m', undefined, 25),
                                exchange.fetchOHLCV(symbol, '15m', undefined, 25)
                            ]);
                            exitPlan = evaluateVolatilePositionExit(p5m, p15m, profitPercentage, peakProfitPct, btcRegime);
                        } catch (e) {}

                        console.log(`[Posizione VOL] ${symbol} (€${(freeCoinAmount * currentPrice).toFixed(2)}) | PnL: ${profitPercentage.toFixed(2)}% | Picco: +${peakProfitPct.toFixed(2)}% | ${exitPlan.exitTag} +${exitPlan.dynamicTpGrossPct.toFixed(2)}% | Aperta: ${minutesOpen.toFixed(0)}m`);

                        if (exitPlan.isTpHit || exitPlan.quickVolatilityHarvest || exitPlan.isTrailingHit || exitPlan.isStopLossHit) {
                            let reasonType = `${exitPlan.exitTag} (+${exitPlan.dynamicTpGrossPct.toFixed(2)}%)`;
                            if (btcRegime.regime === "CRASH_LIVE") reasonType = "CROLLO BTC";
                            else if (exitPlan.isStopLossHit) reasonType = `STOP LOSS / FAST CUT (${STOP_LOSS_FAST_CUT_PCT}%)`;
                            else if (exitPlan.isTrailingHit) reasonType = `TRAILING VOL (picco +${peakProfitPct.toFixed(2)}%)`;
                            else if (exitPlan.quickVolatilityHarvest) reasonType = `INCASSO VOLATILITÀ (picco +${peakProfitPct.toFixed(2)}%)`;

                            const sellBook = await evaluateOrderBookForExecution(symbol, 'sell');
                            if (!sellBook.ok && !exitPlan.isStopLossHit && btcRegime.regime !== "CRASH_LIVE") {
                                console.log(`[BOOK VENDITA IN ATTESA] ${symbol}: ${sellBook.reason}. Rimando chiusura (${reasonType}).`);
                                continue;
                            }

                            console.log(`[VENDITA VOL] Chiusura (${reasonType}) su ${symbol} (PnL: ${profitPercentage.toFixed(2)}%) | ${sellBook.reason || 'Emergenza'}...`);
                            const sellRes = await exchange.createMarketSellOrder(symbol, freeCoinAmount);
                            console.log(`[VENDITA OK] ${symbol} chiusa! ID:`, sellRes.id);
                            lastLog = `Chiuso ${symbol} (${reasonType}) - PnL: ${profitPercentage.toFixed(2)}%`;

                            delete activePositions[symbol];
                            if (profitPercentage <= STOP_LOSS_FAST_CUT_PCT) {
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

                // 2. AGGIORNAMENTO WATCHLIST + MOVERS VOLATILI (CMC + TICKER KRAKEN)
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
                            return !stablecoinsToIgnore.includes(base) && base !== 'ETH' && base !== 'XETH';
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
                                if (stablecoinsToIgnore.includes(baseSym) || baseSym === 'ETH') continue;
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
                        if (exchange.markets[sym] && exchange.markets[sym].active && !validatedWatchlist.includes(sym)) {
                            validatedWatchlist.push(sym);
                        }
                    }

                    validatedWatchlist.sort((a, b) => (volumeMap[b] || 0) - (volumeMap[a] || 0));

                    dailyWinnersSet = nextWinnersSet;
                    dailyLosersSet = nextLosersSet;
                    focusedHotPool = validatedWatchlist;
                    lastHotPoolUpdate = currentTime;
                    console.log(`[Focus VOL] Watchlist (${focusedHotPool.length} coppie | Vincenti: ${dailyWinnersSet.size}, Perdenti: ${dailyLosersSet.size})`);
                }

                if (!btcRegime.allowAltBuys) {
                    console.log(`[Termometro BTC VOL STOP] ${btcRegime.summary}. Nuovi acquisti bloccati.`);
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                if (Date.now() - lastBuyTimestamp < BUY_COOLDOWN_MS) {
                    const waitMin = Math.ceil((BUY_COOLDOWN_MS - (Date.now() - lastBuyTimestamp)) / 60000);
                    console.log(`[Cooldown VOL] In attesa di ${waitMin}m prima del prossimo ingresso da €${ORDER_SIZE_EUR}.`);
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                // 3. SCANNER VOLATILITÀ (5m, 15m, 30m) + BOOK + ORDINE LIMITE
                for (const symbol of focusedHotPool) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        if (stoppedSymbolsCooldown[symbol] && Date.now() < stoppedSymbolsCooldown[symbol]) continue;

                        const [ohlcv5m, ohlcv15m, ohlcv30m] = await Promise.all([
                            exchange.fetchOHLCV(symbol, '5m', undefined, 30),
                            exchange.fetchOHLCV(symbol, '15m', undefined, 30),
                            exchange.fetchOHLCV(symbol, '30m', undefined, 25)
                        ]);
                        if (!ohlcv5m || ohlcv5m.length < 25 || !ohlcv15m || ohlcv15m.length < 25 || !ohlcv30m || ohlcv30m.length < 20) continue;

                        const currentPrice = ohlcv5m[ohlcv5m.length - 1][4];
                        const baseCurrency = symbol.split('/')[0];
                        const matchingKeys = Object.keys(totalBalances).filter(k => {
                            let clean = k.replace(/^[XZ]/, '');
                            if (clean === 'XBT') clean = 'BTC';
                            return clean === baseCurrency;
                        });
                        const existingTotalAmt = matchingKeys.reduce((sum, k) => sum + (totalBalances[k] || 0), 0);
                        if (isMeaningfulHolding(existingTotalAmt, currentPrice)) continue;

                        const setup = evaluateVolatilityEntrySetup(
                            ohlcv5m,
                            ohlcv15m,
                            ohlcv30m,
                            dailyWinnersSet.has(symbol),
                            dailyLosersSet.has(symbol)
                        );
                        if (!setup.valid) continue;

                        const bookEval = await evaluateOrderBookForExecution(symbol, 'buy');
                        if (!bookEval.ok) {
                            console.log(`[Book Filtro VOL] ${symbol} saltato: ${bookEval.reason}`);
                            continue;
                        }

                        let targetInvestmentSize = ORDER_SIZE_EUR;
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        if (eurBalance >= ORDER_SIZE_EUR || eurBalance >= 5) {
                            const refPrice = bookEval.bestBid > 0 ? bookEval.bestBid : currentPrice;
                            const amountToBuy = targetInvestmentSize / refPrice;

                            console.log(`[Buy VOL ${setup.mode}] Tentativo limite €${targetInvestmentSize} su ${symbol} (Score ${setup.score.toFixed(1)}) | ${setup.reason} | ${bookEval.reason}...`);

                            try {
                                const limitResult = await placeTimedLimitBuyOnBook(symbol, amountToBuy, bookEval);
                                if (!limitResult.filled) {
                                    console.log(`[Limit VOL Non Eseguito] ${symbol}: ${limitResult.reason}`);
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
                                console.log(`[BUY LIMIT VOL OK] Acquistati ~€${(actualAmount * actualEntry).toFixed(2)} di ${symbol} @ €${actualEntry} | ${setup.reason}`);
                                lastLog = `Acquistati ~€${(actualAmount * actualEntry).toFixed(2)} di ${symbol} (${setup.mode})`;
                                await new Promise(resolve => setTimeout(resolve, 5000));
                                break;
                            } catch (orderErr) {
                                console.log(`[ERRORE ORDINE KRAKEN su ${symbol}]:`, orderErr.message);
                            }
                        }
                    } catch (altErr) {
                        console.log(`[Errore ciclo volatilità]:`, altErr.message);
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
    console.log(`Server Volatilità in ascolto sulla porta ${PORT}`);
    setTimeout(() => {
        runBotLoop();
    }, 3000);
});
