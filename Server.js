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
let lastLog = "Bot avviato: Fibo Multi-TF (24h/4h/1h/15m/5m) + Supporti (5/15/30m) + EMA/RSI/BB + TP Lordo 1.7% (10€).";
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

// Watchlist richiesta (senza ETH; Cronos -> CRO; coppie non attive su Kraken vengono scartate in automatico)
const customWatchlistSymbols = [
    'PEPE/EUR', 'SUI/EUR', 'SKI/EUR', 'SOL/EUR', 'HYPE/EUR',
    'AAVE/EUR', 'ALLO/EUR', 'WLD/EUR', 'NEAR/EUR', 'SEI/EUR',
    'LINK/EUR', 'GM/EUR', 'CRO/EUR', 'MNT/EUR', 'GRT/EUR',
    'UNI/EUR', 'ENA/EUR'
];

// Parametri Operativi (tempo illimitato fino a TP lordo 1.7% o Stop Loss / Fast Cut)
const ORDER_SIZE_EUR = 10;
const ESTIMATED_ROUNDTRIP_FEE_PCT = 0.50;
const FIXED_TP_GROSS_PCT = 1.70;              // TP lordo fisso a 1.7%

// Protezione trailing e Stop Loss / Fast Cut
const TRAILING_ARM_GROSS_PCT = 1.15;          // Arma il trailing sopra +1.15% lordo
const TRAILING_FLOOR_GROSS_PCT = 0.65;        // Protezione minima sopra le commissioni
const TRAILING_PULLBACK_PCT = 0.35;           // Ritracciamento stretto dal picco prima di incassare
const STOP_LOSS_FAST_CUT_PCT = -1.35;         // Stop loss / fast cut di invalidazione

// Order Book: controllo spread, profondità e ordine limite temporizzato sull'ingresso
const MAX_ALLOWED_SPREAD_PCT = 0.45;          // Blocca se lo spread ask-bid supera lo 0.45%
const MIN_BOOK_DEPTH_EUR = 150;               // Liquidità minima richiesta nei primi livelli del book (€)
const LIMIT_FILL_TIMEOUT_MS = 20000;          // Attesa massima per esecuzione limite sul book (20s per ingressi rapidi)
const LIMIT_POLL_INTERVAL_MS = 3500;          // Controllo stato ordine limite ogni 3.5 secondi

// Filtro residui / briciole in portafoglio
const MIN_TRACKED_POSITION_EUR = 1.50;
const MIN_COIN_AMOUNT_FLOOR = 0.002;

// Selezione & ritmo ingressi veloci su indicatori e supporti
const MIN_TECHNICAL_ENTRY_SCORE = 5.5;
const BUY_COOLDOWN_MS = 5 * 60 * 1000;        // 5 minuti tra un ingresso e l'altro per cogliere piccole occasioni
const SYMBOL_STOP_COOLDOWN_MS = 30 * 60 * 1000;

// Macro & Geopolitica (solo mercati USA aperti lun-ven 15:00-22:30 ora italiana)
const MACRO_INDEX_MAX_DROP_PCT = -1.2;
const OIL_SHOCK_MAX_SPIKE_PCT = 3.5;
const MACRO_LOCK_DURATION_MS = 15 * 60 * 1000;

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>TP Lordo Fisso:</b> +${FIXED_TP_GROSS_PCT}% | <b>Stop/Fast Cut:</b> ${STOP_LOSS_FAST_CUT_PCT}% | <b>Tempo:</b> Illimitato</p>
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

    return {
        weekday,
        isWeekend,
        isUsMarketSession,
        minutesFromMidnight
    };
}

// ================= INDICATORI TECNICI (EMA, RSI, BOLLINGER, FIBONACCI) =================

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

// TERMOMETRO BTC: Ritracciamento Fibonacci su 24h, 4h, 1h, 15m e 5m
async function evaluateBtcMultiTimeframeFibo() {
    try {
        const ticker = await exchange.fetchTicker('BTC/EUR');
        const livePrice = ticker.last;
        if (global.lastBtcLivePrice && livePrice < global.lastBtcLivePrice * 0.988) {
            console.log(`[BTC CROLLO IMPROVVISO] BTC da €${global.lastBtcLivePrice} a €${livePrice}`);
            return {
                allowAltBuys: false,
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
            return { allowAltBuys: false, regime: "NO_DATA", fibScore: 0, summary: "Dati multi-timeframe BTC insufficienti" };
        }

        // 24h = 24 candele da 1h | 4h = ultime 4 candele da 1h (o 16 da 15m) | 1h = ultime 4 candele da 15m | 15m = ultime 3 candele da 5m | 5m = ultime 2 candele da 5m
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

        const allowAltBuys = macroStructureOk && shortTermNotCrashing && !sharpHourlyDump && totalFibScore >= 0.5;
        const regime = allowAltBuys ? "FIBO_ALLINEATO" : "FIBO_DEBOLE_O_ROTTURA";

        const fibDetails = allFibs.map(f => `${f.label}:${f.zone}`).join(" | ");
        const summary = `${regime} | BTC €${livePrice.toFixed(0)} | ScoreFib:${totalFibScore.toFixed(1)} | ${fibDetails}`;
        console.log(`[Termometro BTC Multi-Fib] ${allowAltBuys ? 'OK' : 'STOP'} | ${summary}`);

        return {
            allowAltBuys,
            regime,
            fibScore: totalFibScore,
            summary
        };
    } catch (e) {
        console.log(`[Termometro BTC Multi-Fib] Errore: ${e.message}`);
        return { allowAltBuys: false, regime: "ERRORE", fibScore: 0, summary: "Errore dati BTC" };
    }
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
            return {
                ok: false,
                bestBid,
                bestAsk,
                spreadPct,
                reason: `Spread largo (${spreadPct.toFixed(2)}% > ${MAX_ALLOWED_SPREAD_PCT}%)`
            };
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
            return {
                ok: false,
                bestBid,
                bestAsk,
                spreadPct,
                depthEur,
                reason: `Profondità book bassa lato ${side} (€${depthEur.toFixed(0)} < €${MIN_BOOK_DEPTH_EUR})`
            };
        }

        return {
            ok: true,
            bestBid,
            bestAsk,
            spreadPct,
            depthEur,
            reason: `Book OK (spread ${spreadPct.toFixed(2)}%, prof ${side} €${depthEur.toFixed(0)})`
        };
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
                return {
                    filled: true,
                    execPrice: avgPrice,
                    amount: filledAmount > 0 ? filledAmount : formattedAmount,
                    order: currentOrder
                };
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
        const partialAvg = (typeof afterCancel?.average === 'number' && afterCancel.average > 0)
            ? afterCancel.average
            : avgPrice;

        if (partialFilled > 0 && (partialFilled * partialAvg) >= MIN_TRACKED_POSITION_EUR) {
            return {
                filled: true,
                partial: true,
                execPrice: partialAvg,
                amount: partialFilled,
                order: afterCancel
            };
        }
    } catch (cancelErr) {
        console.log(`[Cancel Ordine Limite ${symbol}]: ${cancelErr.message}`);
    }

    return {
        filled: false,
        reason: `Ordine limite non eseguito entro ${Math.round(LIMIT_FILL_TIMEOUT_MS / 1000)}s (annullato)`
    };
}

// ================= MACRO & GEOPOLITICA (LUN-VEN 15:00-22:30) =================

async function fetchYahooDailyChangePct(tickerSymbol) {
    try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(tickerSymbol)}?range=2d&interval=15m`;
        const res = await axios.get(url, {
            timeout: 4500,
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
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

// ================= ANALISI SUPPORTI (5m, 15m, 30m) + EMA + RSI + BOLLINGER + GAINERS/LOSERS =================

function evaluateMultiSupportAndIndicatorsSetup(ohlcv5m, ohlcv15m, ohlcv30m, isWinner, isLoser) {
    if (!ohlcv5m || ohlcv5m.length < 25 || !ohlcv15m || ohlcv15m.length < 25 || !ohlcv30m || ohlcv30m.length < 20) {
        return { valid: false, score: 0, reason: "Dati multi-timeframe insufficienti" };
    }

    const closes5m = ohlcv5m.map(c => c[4]);
    const lows5m = ohlcv5m.map(c => c[3]);
    const highs5m = ohlcv5m.map(c => c[2]);
    const vols5m = ohlcv5m.map(c => c[5]);

    const closes15m = ohlcv15m.map(c => c[4]);
    const lows15m = ohlcv15m.map(c => c[3]);
    const highs15m = ohlcv15m.map(c => c[2]);

    const closes30m = ohlcv30m.map(c => c[4]);
    const lows30m = ohlcv30m.map(c => c[3]);
    const highs30m = ohlcv30m.map(c => c[2]);

    const currentPrice = closes5m[closes5m.length - 1];
    const prevClose5m = closes5m[closes5m.length - 2];

    // 1. Supporti dinamici su 5m, 15m e 30m (ultime 16 candele esclusa l'ultima)
    const support5m = Math.min(...lows5m.slice(-16, -1));
    const support15m = Math.min(...lows15m.slice(-16, -1));
    const support30m = Math.min(...lows30m.slice(-16, -1));

    const distSup5mPct = support5m > 0 ? ((currentPrice - support5m) / support5m) * 100 : 99;
    const distSup15mPct = support15m > 0 ? ((currentPrice - support15m) / support15m) * 100 : 99;
    const distSup30mPct = support30m > 0 ? ((currentPrice - support30m) / support30m) * 100 : 99;

    // Il prezzo deve reggere sopra i supporti (non in rottura al ribasso) ed essere vicino ad almeno uno di essi
    const notBreakingSupports = currentPrice >= support5m * 0.998 && currentPrice >= support15m * 0.997;
    const nearSupport5m = distSup5mPct >= 0 && distSup5mPct <= 0.75;
    const nearSupport15m = distSup15mPct >= 0 && distSup15mPct <= 1.15;
    const nearSupport30m = distSup30mPct >= 0 && distSup30mPct <= 1.50;

    // 2. Medie Mobili Esponenziali (EMA 9 e EMA 21 su 5m e 15m)
    const ema9_5m = calculateEMA(closes5m, 9);
    const ema21_5m = calculateEMA(closes5m, 21);
    const ema9_15m = calculateEMA(closes15m, 9);
    const ema21_15m = calculateEMA(closes15m, 21);

    // 3. RSI (14) su 5m e 15m
    const rsi5m = calculateRSI(closes5m, 14);
    const rsi15m = calculateRSI(closes15m, 14);

    // 4. Bande di Bollinger (20, 2) su 5m e 15m
    const bb5m = calculateBollingerBands(closes5m, 20, 2);
    const bb15m = calculateBollingerBands(closes15m, 20, 2);

    // 5. Spazio verso la resistenza locale (massimi recenti 15m/30m) per assicurarsi spazio per il +1.7% lordo
    const localRes30m = Math.max(...highs30m.slice(-12));
    const roomToResPct = currentPrice > 0 ? ((localRes30m - currentPrice) / currentPrice) * 100 : 0;

    // 6. Volumi 5m
    const avgVol5m = vols5m.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
    const lastVol5m = vols5m[vols5m.length - 1];

    let score = 0;
    const reasons = [];

    // Punteggio Supporti 5m / 15m / 30m
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

    // Punteggio RSI (ipervenduto / ripartenza tra 30 e 58)
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

    // Punteggio Medie Mobili EMA 9 / EMA 21
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

    // Punteggio Bande di Bollinger (rimbalzo dalla banda inferiore o mediana)
    if (bb5m && currentPrice <= bb5m.middle && currentPrice >= bb5m.lower * 0.997 && currentPrice >= prevClose5m) {
        score += 1.25;
        reasons.push("Rimbalzo BB 5m");
    }
    if (bb15m && currentPrice <= bb15m.middle && currentPrice >= bb15m.lower * 0.997) {
        score += 0.75;
        reasons.push("Zona bassa BB 15m");
    }

    // Punteggio Volumi
    if (avgVol5m > 0 && lastVol5m >= avgVol5m * 1.1) {
        score += 0.75;
        reasons.push("Volumi +");
    }

    // Bonus/Contesto da lista Vincenti e Perdenti (Gainers / Losers in rimbalzo)
    if (isWinner) {
        score += 1.0;
        reasons.push("Top Gainer");
    } else if (isLoser && (nearSupport15m || nearSupport30m) && rsi5m <= 48 && currentPrice >= prevClose5m) {
        score += 1.25;
        reasons.push("Top Loser su supporto");
    }

    // Verifica spazio minimo verso resistenza recente per poter chiudere il +1.7% lordo
    if (roomToResPct < 1.15) {
        score -= 1.5;
        reasons.push(`Resistenza vicina (+${roomToResPct.toFixed(1)}%)`);
    }

    const hasSupportConfluence = nearSupport5m || nearSupport15m || nearSupport30m;
    const valid = notBreakingSupports && hasSupportConfluence && score >= MIN_TECHNICAL_ENTRY_SCORE && currentPrice >= prevClose5m;

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
                if (macroStatus.blocked) {
                    console.log(`[MACRO/GEO BLOCCATO] ${macroStatus.reason}. Nuovi acquisti in pausa.`);
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                const btcRegime = await evaluateBtcMultiTimeframeFibo();

                const totalBalances = balance.total || {};
                const assetKeys = Object.keys(totalBalances).filter(rawCurrency => {
                    if (stablecoinsToIgnore.includes(rawCurrency)) return false;
                    const amt = totalBalances[rawCurrency] || 0;
                    if (amt <= MIN_COIN_AMOUNT_FLOOR) return false;
                    let clean = rawCurrency.replace(/^[XZ]/, '');
                    if (clean === 'XBT') clean = 'BTC';
                    return !stablecoinsToIgnore.includes(clean);
                });

                // 1. GESTIONE POSIZIONI APERTE (Tempo illimitato fino a TP lordo 1.7%, trailing o Stop Loss / Fast Cut)
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

                        // Trailing protettivo stretto se sale oltre +1.15% lordo ma ritraccia prima del +1.70%
                        let isTrailingHit = false;
                        if (peakProfitPct >= TRAILING_ARM_GROSS_PCT) {
                            const trailingStopLevel = Math.max(TRAILING_FLOOR_GROSS_PCT, peakProfitPct - TRAILING_PULLBACK_PCT);
                            if (profitPercentage <= trailingStopLevel) {
                                isTrailingHit = true;
                            }
                        }

                        const isTpHit = profitPercentage >= FIXED_TP_GROSS_PCT;
                        const isStopLossHit = profitPercentage <= STOP_LOSS_FAST_CUT_PCT || btcRegime.regime === "CRASH_LIVE";

                        console.log(`[Posizione] ${symbol} (€${(freeCoinAmount * currentPrice).toFixed(2)}) | PnL: ${profitPercentage.toFixed(2)}% | Picco: +${peakProfitPct.toFixed(2)}% | TP Lordo: +${FIXED_TP_GROSS_PCT}% | Aperta: ${minutesOpen.toFixed(0)}m (ILLIMITATA)`);

                        if (isTpHit || isTrailingHit || isStopLossHit) {
                            let reasonType = `TP LORDO (+${FIXED_TP_GROSS_PCT}%)`;
                            if (btcRegime.regime === "CRASH_LIVE") reasonType = "CROLLO BTC";
                            else if (isStopLossHit) reasonType = `STOP LOSS / FAST CUT (${STOP_LOSS_FAST_CUT_PCT}%)`;
                            else if (isTrailingHit) reasonType = `TRAILING PROTETTIVO (picco +${peakProfitPct.toFixed(2)}%)`;

                            const sellBook = await evaluateOrderBookForExecution(symbol, 'sell');
                            if (!sellBook.ok && !isStopLossHit && btcRegime.regime !== "CRASH_LIVE") {
                                console.log(`[BOOK VENDITA IN ATTESA] ${symbol}: ${sellBook.reason}. Rimando chiusura (${reasonType}).`);
                                continue;
                            }

                            console.log(`[VENDITA] Chiusura (${reasonType}) su ${symbol} (PnL: ${profitPercentage.toFixed(2)}%) | ${sellBook.reason || 'Emergenza'}...`);
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

                // 2. AGGIORNAMENTO WATCHLIST + VINCENTI & PERDENTI (GAINERS & LOSERS)
                const currentTime = Date.now();
                if (focusedHotPool.length === 0 || (currentTime - lastHotPoolUpdate > 10 * 60 * 1000)) {
                    let candidateSymbols = [...customWatchlistSymbols];
                    let volumeMap = {};
                    const nextWinnersSet = new Set();
                    const nextLosersSet = new Set();

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
                                if (exchange.markets[sym] && exchange.markets[sym].active) {
                                    if (pct24h >= 2.0) {
                                        nextWinnersSet.add(sym);
                                        if (!candidateSymbols.includes(sym)) candidateSymbols.push(sym);
                                    } else if (pct24h <= -2.0) {
                                        nextLosersSet.add(sym);
                                        if (!candidateSymbols.includes(sym)) candidateSymbols.push(sym);
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
                        return (volumeMap[baseB] || 0) - (volumeMap[baseA] || 0);
                    });

                    dailyWinnersSet = nextWinnersSet;
                    dailyLosersSet = nextLosersSet;
                    focusedHotPool = validatedWatchlist;
                    lastHotPoolUpdate = currentTime;
                    console.log(`[Focus] Watchlist (${focusedHotPool.length} coppie | Vincenti: ${dailyWinnersSet.size}, Perdenti: ${dailyLosersSet.size}): ${focusedHotPool.join(', ')}`);
                }

                if (!btcRegime.allowAltBuys) {
                    console.log(`[Termometro BTC STOP] ${btcRegime.summary}. Nuovi acquisti bloccati.`);
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                if (Date.now() - lastBuyTimestamp < BUY_COOLDOWN_MS) {
                    const waitMin = Math.ceil((BUY_COOLDOWN_MS - (Date.now() - lastBuyTimestamp)) / 60000);
                    console.log(`[Cooldown] In attesa di ${waitMin}m prima del prossimo ingresso da €${ORDER_SIZE_EUR}.`);
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                // 3. SCANNER SUPPORTI (5m, 15m, 30m) + EMA/RSI/BB + VINCENTI & PERDENTI
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

                        const setup = evaluateMultiSupportAndIndicatorsSetup(
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

                            console.log(`[Buy Tecnico] Tentativo limite €${targetInvestmentSize} su ${symbol} (Score ${setup.score.toFixed(1)}, TP +${FIXED_TP_GROSS_PCT}%) | ${setup.reason} | ${bookEval.reason}...`);

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
                                lastLog = `Acquistati ~€${(actualAmount * actualEntry).toFixed(2)} di ${symbol} (TP Lordo +${FIXED_TP_GROSS_PCT}%)`;
                                await new Promise(resolve => setTimeout(resolve, 5000));
                                break;
                            } catch (orderErr) {
                                console.log(`[ERRORE ORDINE KRAKEN su ${symbol}]:`, orderErr.message);
                            }
                        }
                    } catch (altErr) {
                        console.log(`[Errore ciclo altcoin]:`, altErr.message);
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
