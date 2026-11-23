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
let lastLog = "Bot avviato: Tempo Illimitato fino a TP/Stop + Termometro BTC Fibonacci & Weekend (10€).";
let focusedHotPool = [];
let dailyWinnersSet = new Set();
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

// Parametri Operativi (tempo di apertura ILLIMITATO fino a TP, trailing, rallentamento o stop loss / fast cut)
const ORDER_SIZE_EUR = 10;
const TIMEFRAME_ENTRY = '5m';
const TIMEFRAME_STRUCTURE = '1h';
const ESTIMATED_ROUNDTRIP_FEE_PCT = 0.50;

// Uscite elastiche con allargamento calcolato e paracadute se si ferma prima del TP esteso
const MIN_TP_NET_PCT = 1.10;                  // ~1.60% lordo minimo quando lo spazio è corto
const BASE_TP_NET_PCT = 1.80;                 // ~2.30% lordo target base su cambio di fase
const MAX_DYNAMIC_TP_NET_PCT = 4.20;          // Tetto massimo calcolato (~4.70% lordo) se spinta e spazio confermano
const TRAILING_ARM_GROSS_PCT = 1.25;          // Arma il trailing sopra +1.25% lordo
const TRAILING_FLOOR_GROSS_PCT = 0.65;        // Protezione minima sopra le fee una volta armato
const TRAILING_PULLBACK_PCT = 0.65;           // Ritracciamento standard dal picco prima di incassare
const EXTENDED_GAIN_TRAILING_ARM_PCT = 2.40;  // Sopra +2.40% lordo stringe il paracadute per non restituire il guadagno
const EXTENDED_GAIN_PULLBACK_PCT = 0.45;      // Margine di ritracciamento dal picco quando è già in forte utile
const STOP_LOSS_FAST_CUT_PCT = -1.35;         // Stop loss / fast cut di invalidazione

// Order Book: controllo spread, profondità e ordine limite temporizzato sull'ingresso
const MAX_ALLOWED_SPREAD_PCT = 0.45;          // Blocca se lo spread ask-bid supera lo 0.45%
const MIN_BOOK_DEPTH_EUR = 150;               // Liquidità minima richiesta nei primi livelli del book (€)
const LIMIT_FILL_TIMEOUT_MS = 25000;          // Attesa massima per l'esecuzione dell'ordine limite sul book
const LIMIT_POLL_INTERVAL_MS = 4000;          // Controllo stato ordine limite ogni 4 secondi

// Filtro residui / briciole in portafoglio
const MIN_TRACKED_POSITION_EUR = 1.50;
const MIN_COIN_AMOUNT_FLOOR = 0.002;

// Selezione & ritmo ingressi
const MIN_DAY_REBOUND_SCORE = 6.5;
const BUY_COOLDOWN_MS = 12 * 60 * 1000;
const SYMBOL_STOP_COOLDOWN_MS = 40 * 60 * 1000;

// Macro & Geopolitica (solo mercati tradizionali aperti lun-ven; in weekend / domenica è disattivato)
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

    return {
        weekday,
        isSunday: weekday === 'Sun',
        isWeekend: weekday === 'Sat' || weekday === 'Sun',
        minutesFromMidnight: hour * 60 + minute
    };
}

function isTraditionalMarketOpenNow() {
    try {
        const info = getItalyDayAndMinutes();
        if (info.isWeekend) return false;
        return info.minutesFromMidnight >= (15 * 60) && info.minutesFromMidnight <= (22 * 60 + 30);
    } catch (e) {
        return false;
    }
}

// Calcola livelli di ritracciamento Fibonacci tra swingLow e swingHigh (dal basso verso l'alto)
function calculateFibonacciLevels(swingLow, swingHigh) {
    const diff = swingHigh - swingLow;
    if (!swingLow || !swingHigh || diff <= 0) {
        return null;
    }
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

// Legge posizione e reazione di BTC rispetto ai livelli di Fibonacci (con adattamento specifico per la domenica/weekend)
function analyzeBtcFibonacciStructure(ohlcv1h, livePrice, isSunday) {
    if (!ohlcv1h || ohlcv1h.length < 16 || !livePrice || livePrice <= 0) {
        return {
            fibValid: false,
            fibAllowsBuys: false,
            fibBoost: 0,
            fibSummary: "Fibo N/D"
        };
    }

    const windowCandles = isSunday ? ohlcv1h.slice(-36) : ohlcv1h.slice(-24);
    const swingLow = Math.min(...windowCandles.map(c => c[3]));
    const swingHigh = Math.max(...windowCandles.map(c => c[2]));
    const fib = calculateFibonacciLevels(swingLow, swingHigh);

    if (!fib) {
        return {
            fibValid: false,
            fibAllowsBuys: true,
            fibBoost: 0,
            fibSummary: "Range Fibo piatto"
        };
    }

    const lastCandle = ohlcv1h[ohlcv1h.length - 1];
    const prevCandle = ohlcv1h[ohlcv1h.length - 2];
    const candleTurningUp = livePrice >= lastCandle[1] || lastCandle[4] >= prevCandle[4];
    const breakingDeepFibo = livePrice < fib.fib0786 * 0.997;

    let zoneLabel = "SOPRA 0.236";
    let fibBoost = 0;
    let fibAllowsBuys = true;

    if (breakingDeepFibo) {
        zoneLabel = "ROTTO 0.786 (DEBOLE)";
        fibAllowsBuys = false;
        fibBoost = -0.30;
    } else if (livePrice >= fib.fib0236) {
        zoneLabel = "ZONA 0.0-0.236 (FORTE)";
        fibBoost = 0.25;
    } else if (livePrice >= fib.fib0382) {
        zoneLabel = "SU FIB 0.382";
        fibBoost = candleTurningUp ? 0.35 : 0.05;
    } else if (livePrice >= fib.fib0500) {
        zoneLabel = "SU FIB 0.50";
        fibBoost = candleTurningUp ? 0.45 : 0.0;
    } else if (livePrice >= fib.fib0618) {
        zoneLabel = "GOLDEN POCKET 0.618";
        fibBoost = candleTurningUp ? 0.50 : -0.10;
        if (isSunday && !candleTurningUp) fibAllowsBuys = false;
    } else {
        zoneLabel = "SOTTO 0.618 -> 0.786";
        fibBoost = -0.15;
        if (isSunday && !candleTurningUp) fibAllowsBuys = false;
    }

    const fibSummary = `Fib[${zoneLabel} | 0.382:€${fib.fib0382.toFixed(0)} | 0.5:€${fib.fib0500.toFixed(0)} | 0.618:€${fib.fib0618.toFixed(0)} | 0.786:€${fib.fib0786.toFixed(0)}]`;
    return {
        fibValid: true,
        fibAllowsBuys,
        fibBoost,
        fibSummary,
        levels: fib
    };
}

// Punto 1: Lettura order book, controllo spread e profondità per il lato richiesto ('buy' o 'sell')
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
                reason: `Spread troppo largo (${spreadPct.toFixed(2)}% > ${MAX_ALLOWED_SPREAD_PCT}%)`
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
                reason: `Profondità book insufficiente lato ${side} (€${depthEur.toFixed(0)} < €${MIN_BOOK_DEPTH_EUR})`
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

// Punto 2: Ordine limite competitivo sul book con controllo di esecuzione e cancellazione se resta appeso
async function placeTimedLimitBuyOnBook(symbol, amountToBuy, bookInfo) {
    const rawLimitPrice = bookInfo && bookInfo.bestBid ? bookInfo.bestBid : 0;
    if (!rawLimitPrice || rawLimitPrice <= 0) {
        return { filled: false, reason: "Prezzo bid non disponibile per ordine limite" };
    }

    const formattedPrice = Number(exchange.priceToPrecision(symbol, rawLimitPrice));
    const formattedAmount = Number(exchange.amountToPrecision(symbol, amountToBuy));

    if (!formattedPrice || !formattedAmount || formattedAmount <= 0) {
        return { filled: false, reason: "Quantità o prezzo limite non formattabili" };
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
                console.log(`[LIMIT IN RITARDO] Prezzo ${symbol} salito a €${ticker.last} oltre limite €${formattedPrice}, cancello ordine limite.`);
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
    if (!isTraditionalMarketOpenNow()) {
        macroLockedUntil = 0;
        return { blocked: false, reason: "Mercati tradizionali chiusi (weekend / domenica)" };
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

// TERMOMETRO BTC: struttura giornaliera/1h + ritracciamento Fibonacci + modalità domenica
async function evaluateBtcDailyRegime() {
    const dayInfo = getItalyDayAndMinutes();
    const isSunday = dayInfo.isSunday;
    const minReboundRequired = isSunday ? 0.25 : 0.35;

    try {
        const ticker = await exchange.fetchTicker('BTC/EUR');
        const livePrice = ticker.last;
        if (global.lastBtcLivePrice && livePrice < global.lastBtcLivePrice * 0.988) {
            console.log(`[BTC CROLLO IMPROVVISO] BTC da ${global.lastBtcLivePrice} a ${livePrice}`);
            return {
                allowAltBuys: false,
                regime: "CRASH_LIVE",
                btcChange24hPct: 0,
                fibBoost: 0,
                isSunday,
                summary: `Crollo live BTC a €${livePrice.toFixed(0)}`
            };
        }
        global.lastBtcLivePrice = livePrice;

        const ohlcv1h = await exchange.fetchOHLCV('BTC/EUR', TIMEFRAME_STRUCTURE, undefined, 40);
        if (!ohlcv1h || ohlcv1h.length < 12) {
            return { allowAltBuys: false, regime: "NO_DATA", btcChange24hPct: 0, fibBoost: 0, isSunday, summary: "Dati 1h BTC insufficienti" };
        }

        const last24h = ohlcv1h.slice(-24);
        const dayLow = Math.min(...last24h.map(c => c[3]));
        const dayHigh = Math.max(...last24h.map(c => c[2]));
        const start24hOpen = last24h[0][1];
        const btcChange24hPct = start24hOpen > 0 ? ((livePrice - start24hOpen) / start24hOpen) * 100 : 0;

        const lastCandle = ohlcv1h[ohlcv1h.length - 1];
        const prevCandle = ohlcv1h[ohlcv1h.length - 2];
        const threeCandlesAgo = ohlcv1h[ohlcv1h.length - 4];

        const reboundFromDayLowPct = dayLow > 0 ? ((livePrice - dayLow) / dayLow) * 100 : 0;
        const recentDropBeforeLowPct = dayHigh > 0 ? ((dayHigh - dayLow) / dayHigh) * 100 : 0;

        const makingFreshBreakdown = (lastCandle[3] < prevCandle[3] * 0.997) && (lastCandle[4] < prevCandle[4]);
        const heavyFreefall = ((lastCandle[4] - threeCandlesAgo[1]) / threeCandlesAgo[1]) * 100 < -1.4;

        const fibAnalysis = analyzeBtcFibonacciStructure(ohlcv1h, livePrice, isSunday);

        const isReversalOrReboundPhase =
            !makingFreshBreakdown &&
            !heavyFreefall &&
            fibAnalysis.fibAllowsBuys &&
            reboundFromDayLowPct >= minReboundRequired &&
            (lastCandle[4] >= prevCandle[4] || btcChange24hPct > -2.5);

        const dayTag = isSunday ? "DOMENICA_FIB" : "STRUTTURA_FIB";
        const regime = isReversalOrReboundPhase
            ? (recentDropBeforeLowPct >= 1.5 ? "CAMBIO_FASE_DOPO_SCARICO" : "SPINTA_GIORNALIERA")
            : "PRESSIONE_RIBASSISTA";

        const summary = `${dayTag}/${regime} | Prezzo €${livePrice.toFixed(0)} | 24h ${btcChange24hPct >= 0 ? '+' : ''}${btcChange24hPct.toFixed(2)}% | Min24h €${dayLow.toFixed(0)} (+${reboundFromDayLowPct.toFixed(2)}%) | Max24h €${dayHigh.toFixed(0)} | ${fibAnalysis.fibSummary}`;
        console.log(`[Termometro BTC] ${isReversalOrReboundPhase ? 'OK' : 'STOP'} | ${summary}`);

        return {
            allowAltBuys: isReversalOrReboundPhase,
            regime,
            btcChange24hPct,
            fibBoost: fibAnalysis.fibBoost,
            isSunday,
            summary
        };
    } catch (e) {
        console.log(`[Termometro BTC] Errore lettura: ${e.message}`);
        return { allowAltBuys: false, regime: "ERRORE", btcChange24hPct: 0, fibBoost: 0, isSunday, summary: "Errore dati BTC" };
    }
}

// VALUTA LA POSIZIONE NELLA GIORNATA, IL SETUP E L'ALLARGAMENTO CALCOLATO DEL TP + SEGNALE DI ESAURIMENTO SPINTA
function evaluateAltDailySetup(ohlcv5m, ohlcv1h, isDailyWinner, btcRegime) {
    if (!ohlcv5m || ohlcv5m.length < 24 || !ohlcv1h || ohlcv1h.length < 12) {
        return {
            valid: false,
            score: 0,
            dynamicTpGrossPct: Number((BASE_TP_NET_PCT + ESTIMATED_ROUNDTRIP_FEE_PCT).toFixed(2)),
            momentumFading: false,
            reason: "Dati insufficienti"
        };
    }

    const closes5m = ohlcv5m.map(c => c[4]);
    const lows5m = ohlcv5m.map(c => c[3]);
    const vols5m = ohlcv5m.map(c => c[5]);

    const currentPrice = closes5m[closes5m.length - 1];
    const prevClose = closes5m[closes5m.length - 2];
    const prevPrevClose = closes5m[closes5m.length - 3];

    const last24h1h = ohlcv1h.slice(-24);
    const dayLow = Math.min(...last24h1h.map(c => c[3]));
    const dayHigh = Math.max(...last24h1h.map(c => c[2]));
    const dayOpen = last24h1h[0][1];
    const dayChangePct = dayOpen > 0 ? ((currentPrice - dayOpen) / dayOpen) * 100 : 0;

    const range24h = dayHigh - dayLow;
    const positionInDayRange = range24h > 0 ? (currentPrice - dayLow) / range24h : 0.5;
    const reboundFromDayLowPct = dayLow > 0 ? ((currentPrice - dayLow) / dayLow) * 100 : 0;
    const upsideRoomToDayHighPct = currentPrice > 0 ? ((dayHigh - currentPrice) / currentPrice) * 100 : 0;

    const recentLow5m = Math.min(...lows5m.slice(-18, -2));
    const holdingAboveLocalLow = currentPrice > recentLow5m * 1.002 && lows5m[lows5m.length - 1] >= recentLow5m * 0.998;

    const avgVol = vols5m.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
    const lastVol = vols5m[vols5m.length - 1];
    const greenCandlesLast4 = [
        closes5m[closes5m.length - 1] > closes5m[closes5m.length - 2],
        closes5m[closes5m.length - 2] > closes5m[closes5m.length - 3],
        closes5m[closes5m.length - 3] > closes5m[closes5m.length - 4],
        closes5m[closes5m.length - 4] > closes5m[closes5m.length - 5]
    ].filter(Boolean).length;

    let score = btcRegime.fibBoost || 0;
    const reasons = [];

    if (positionInDayRange <= 0.65 && upsideRoomToDayHighPct >= 1.4) {
        score += 3.0;
        reasons.push(`Zona favorevole giornata (spazio max +${upsideRoomToDayHighPct.toFixed(1)}%)`);
    } else if (positionInDayRange > 0.85 || upsideRoomToDayHighPct < 0.9) {
        score -= 2.5;
        reasons.push("Troppo vicina al massimo di giornata");
    }

    if (holdingAboveLocalLow && reboundFromDayLowPct >= 0.4) {
        score += 2.5;
        reasons.push(`Tiene sopra minimo (+${reboundFromDayLowPct.toFixed(1)}% da min24h)`);
    }

    if (greenCandlesLast4 >= 2 && currentPrice >= prevClose) {
        score += 2.0;
        reasons.push(`Svolta 5m (${greenCandlesLast4}/4 verdi)`);
    }

    if (isDailyWinner || dayChangePct > 1.5) {
        score += 1.5;
        reasons.push(`Forza giornaliera (${dayChangePct >= 0 ? '+' : ''}${dayChangePct.toFixed(1)}%)`);
    }

    if (avgVol > 0 && lastVol >= avgVol * 1.1) {
        score += 1.0;
        reasons.push("Volumi presenti");
    }

    let targetNet = BASE_TP_NET_PCT;
    if (btcRegime.allowAltBuys) {
        if (btcRegime.regime === "CAMBIO_FASE_DOPO_SCARICO") {
            targetNet += 0.45;
        }
        if (upsideRoomToDayHighPct >= 2.2) {
            targetNet += Math.min(0.95, (upsideRoomToDayHighPct - 1.5) * 0.35);
        }
        if (greenCandlesLast4 >= 3 && avgVol > 0 && lastVol >= avgVol * 1.15) {
            targetNet += 0.40;
        }
        if (isDailyWinner) {
            targetNet += 0.25;
        }
    } else {
        targetNet = Math.min(targetNet, 1.35);
    }

    if (upsideRoomToDayHighPct > 0 && upsideRoomToDayHighPct < 1.3) {
        targetNet = Math.min(targetNet, MIN_TP_NET_PCT);
    }

    targetNet = Math.max(MIN_TP_NET_PCT, Math.min(MAX_DYNAMIC_TP_NET_PCT, targetNet));
    const dynamicTpGrossPct = Number((targetNet + ESTIMATED_ROUNDTRIP_FEE_PCT).toFixed(2));

    const twoRedCandles = currentPrice < prevClose && prevClose < prevPrevClose;
    const nearDayHigh = upsideRoomToDayHighPct <= 0.85 && currentPrice < prevClose;
    const lowVolumePullback = avgVol > 0 && lastVol < avgVol * 0.75 && currentPrice < prevClose;
    const momentumFading = twoRedCandles || nearDayHigh || lowVolumePullback;

    const valid = score >= MIN_DAY_REBOUND_SCORE && holdingAboveLocalLow && upsideRoomToDayHighPct >= 1.1;
    return {
        valid,
        score,
        dynamicTpGrossPct,
        momentumFading,
        reason: reasons.join(" + ") || "Setup non maturo"
    };
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

                const macroStatus = await evaluateMacroAndGeopolitics();
                if (macroStatus.blocked) {
                    console.log(`[MACRO/GEO BLOCCATO] ${macroStatus.reason}. Nuovi acquisti in pausa.`);
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                const btcRegime = await evaluateBtcDailyRegime();

                const totalBalances = balance.total || {};
                const assetKeys = Object.keys(totalBalances).filter(rawCurrency => {
                    if (stablecoinsToIgnore.includes(rawCurrency)) return false;
                    const amt = totalBalances[rawCurrency] || 0;
                    if (amt <= MIN_COIN_AMOUNT_FLOOR) return false;
                    let clean = rawCurrency.replace(/^[XZ]/, '');
                    if (clean === 'XBT') clean = 'BTC';
                    return !stablecoinsToIgnore.includes(clean);
                });

                // 1. GESTIONE POSIZIONI APERTE (tempo illimitato fino a TP, trailing, rallentamento o stop loss / fast cut)
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

                        let dynamicTpGrossPct = Number((BASE_TP_NET_PCT + ESTIMATED_ROUNDTRIP_FEE_PCT).toFixed(2));
                        let momentumFading = false;
                        try {
                            const [pos5m, pos1h] = await Promise.all([
                                exchange.fetchOHLCV(symbol, TIMEFRAME_ENTRY, undefined, 24),
                                exchange.fetchOHLCV(symbol, TIMEFRAME_STRUCTURE, undefined, 24)
                            ]);
                            const setup = evaluateAltDailySetup(pos5m, pos1h, dailyWinnersSet.has(symbol), btcRegime);
                            dynamicTpGrossPct = setup.dynamicTpGrossPct;
                            momentumFading = setup.momentumFading;
                        } catch (e) {}

                        let isTrailingHit = false;
                        if (peakProfitPct >= TRAILING_ARM_GROSS_PCT) {
                            const activePullback = peakProfitPct >= EXTENDED_GAIN_TRAILING_ARM_PCT
                                ? EXTENDED_GAIN_PULLBACK_PCT
                                : TRAILING_PULLBACK_PCT;
                            const dynamicFloor = peakProfitPct >= EXTENDED_GAIN_TRAILING_ARM_PCT
                                ? Math.max(TRAILING_FLOOR_GROSS_PCT, peakProfitPct - 0.85)
                                : TRAILING_FLOOR_GROSS_PCT;
                            const trailingStopLevel = Math.max(dynamicFloor, peakProfitPct - activePullback);

                            if (profitPercentage <= trailingStopLevel) {
                                isTrailingHit = true;
                            }
                        }

                        const isFadeProfitHit = momentumFading && profitPercentage >= (ESTIMATED_ROUNDTRIP_FEE_PCT + 0.85) && peakProfitPct > profitPercentage + 0.25;
                        const isTpHit = profitPercentage >= dynamicTpGrossPct;
                        const isStopLossHit = profitPercentage <= STOP_LOSS_FAST_CUT_PCT || btcRegime.regime === "CRASH_LIVE";

                        console.log(`[Posizione] ${symbol} (€${(freeCoinAmount * currentPrice).toFixed(2)}) | PnL: ${profitPercentage.toFixed(2)}% | Picco: +${peakProfitPct.toFixed(2)}% | TP: +${dynamicTpGrossPct}% | Aperta: ${minutesOpen.toFixed(0)}m (ILLIMITATA)`);

                        if (isTpHit || isTrailingHit || isFadeProfitHit || isStopLossHit) {
                            let reasonType = "TP DINAMICO";
                            if (btcRegime.regime === "CRASH_LIVE") reasonType = "CROLLO BTC";
                            else if (isStopLossHit) reasonType = `STOP LOSS / FAST CUT (${STOP_LOSS_FAST_CUT_PCT}%)`;
                            else if (isTrailingHit) reasonType = `TRAILING STOP (picco +${peakProfitPct.toFixed(2)}%)`;
                            else if (isFadeProfitHit) reasonType = `INCASSO SU RALLENTAMENTO (picco +${peakProfitPct.toFixed(2)}%)`;
                            else if (isTpHit) reasonType = `TP DINAMICO (+${dynamicTpGrossPct}%)`;

                            const sellBook = await evaluateOrderBookForExecution(symbol, 'sell');
                            if (!sellBook.ok && !isStopLossHit && btcRegime.regime !== "CRASH_LIVE") {
                                console.log(`[BOOK VENDITA IN ATTESA] ${symbol}: ${sellBook.reason}. Rimando chiusura (${reasonType}) al prossimo ciclo.`);
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

                // 2. AGGIORNAMENTO WATCHLIST + VINCENTI DI GIORNATA + VOLUMI CMC
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
                        return (volumeMap[baseB] || 0) - (volumeMap[baseA] || 0);
                    });

                    dailyWinnersSet = nextWinnersSet;
                    focusedHotPool = validatedWatchlist;
                    lastHotPoolUpdate = currentTime;
                    console.log(`[Focus] Watchlist (${focusedHotPool.length} coppie): ${focusedHotPool.join(', ')}`);
                }

                if (!btcRegime.allowAltBuys) {
                    console.log(`[In attesa cambio fase BTC] ${btcRegime.summary}. Nuovi acquisti bloccati.`);
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                if (Date.now() - lastBuyTimestamp < BUY_COOLDOWN_MS) {
                    const waitMin = Math.ceil((BUY_COOLDOWN_MS - (Date.now() - lastBuyTimestamp)) / 60000);
                    console.log(`[Cooldown] In attesa di ${waitMin}m prima del prossimo ingresso da €${ORDER_SIZE_EUR}.`);
                    await new Promise(resolve => setTimeout(resolve, 20000));
                    continue;
                }

                // 3. SCANNER GIORNALIERO / CAMBIO DI FASE SULLE ALTCOIN + LETTURA BOOK & ORDINE LIMITE
                for (const symbol of focusedHotPool) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        if (stoppedSymbolsCooldown[symbol] && Date.now() < stoppedSymbolsCooldown[symbol]) continue;

                        const [ohlcv5m, ohlcv1h] = await Promise.all([
                            exchange.fetchOHLCV(symbol, TIMEFRAME_ENTRY, undefined, 25),
                            exchange.fetchOHLCV(symbol, TIMEFRAME_STRUCTURE, undefined, 24)
                        ]);
                        if (!ohlcv5m || ohlcv5m.length < 24 || !ohlcv1h || ohlcv1h.length < 12) continue;

                        const currentPrice = ohlcv5m[ohlcv5m.length - 1][4];
                        const baseCurrency = symbol.split('/')[0];
                        const matchingKeys = Object.keys(totalBalances).filter(k => {
                            let clean = k.replace(/^[XZ]/, '');
                            if (clean === 'XBT') clean = 'BTC';
                            return clean === baseCurrency;
                        });
                        const existingTotalAmt = matchingKeys.reduce((sum, k) => sum + (totalBalances[k] || 0), 0);
                        if (isMeaningfulHolding(existingTotalAmt, currentPrice)) continue;

                        const setup = evaluateAltDailySetup(ohlcv5m, ohlcv1h, dailyWinnersSet.has(symbol), btcRegime);
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

                            console.log(`[Buy Setup Book] Tentativo limite da €${targetInvestmentSize} su ${symbol} (Score ${setup.score.toFixed(1)}, TP +${setup.dynamicTpGrossPct}%) | ${bookEval.reason}...`);

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
                                lastLog = `Acquistati ~€${(actualAmount * actualEntry).toFixed(2)} di ${symbol} (TP +${setup.dynamicTpGrossPct}%)`;
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
