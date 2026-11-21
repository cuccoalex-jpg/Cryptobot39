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
let lastLog = "Bot avviato: Logica Giornaliera / Cambio Fase BTC + Posizione nella Giornata (10€).";
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

// Parametri Operativi Giornalieri / Intraday
const ORDER_SIZE_EUR = 10;
const TIMEFRAME_ENTRY = '5m';
const TIMEFRAME_STRUCTURE = '1h';
const MAX_HOLD_MINUTES = 180;                 // Fino a 3 ore per seguire una svolta intraday/giornaliera
const ESTIMATED_ROUNDTRIP_FEE_PCT = 0.50;

// Uscite elastiche legate alla forza del movimento giornaliero
const MIN_TP_NET_PCT = 1.10;                  // ~1.60% lordo minimo quando il movimento è corto
const BASE_TP_NET_PCT = 1.80;                 // ~2.30% lordo target base su cambio di fase
const MAX_DYNAMIC_TP_NET_PCT = 4.20;          // Fino a ~4.70% lordo se spinge con forza nella giornata
const TRAILING_ARM_GROSS_PCT = 1.30;          // Arma il trailing sopra +1.30% lordo
const TRAILING_FLOOR_GROSS_PCT = 0.60;        // Protegge almeno +0.60% lordo una volta armato
const TRAILING_PULLBACK_PCT = 0.70;           // Lascia respirare il prezzo (0.70% dal picco) prima di chiudere
const STOP_LOSS_FAST_CUT_PCT = -1.35;         // Invalidazione / stop loss

// Filtro residui / briciole in portafoglio
const MIN_TRACKED_POSITION_EUR = 1.50;
const MIN_COIN_AMOUNT_FLOOR = 0.002;

// Selezione & ritmo ingressi
const MIN_DAY_REBOUND_SCORE = 6.5;
const BUY_COOLDOWN_MS = 12 * 60 * 1000;
const SYMBOL_STOP_COOLDOWN_MS = 40 * 60 * 1000;

// Macro & Geopolitica (solo mercati tradizionali aperti lun-ven)
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

function isTraditionalMarketOpenNow() {
    try {
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

        if (weekday === 'Sat' || weekday === 'Sun') return false;

        const minutesFromMidnight = hour * 60 + minute;
        return minutesFromMidnight >= (15 * 60) && minutesFromMidnight <= (22 * 60 + 30);
    } catch (e) {
        return false;
    }
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
        return { blocked: false, reason: "Mercati tradizionali chiusi" };
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

// ANALIZZA LA GIORNATA / CAMBIO DI FASE DI BTC (es. dopo uno short/discesa, cerca tenuta del minimo e svolta)
async function evaluateBtcDailyRegime() {
    try {
        const ticker = await exchange.fetchTicker('BTC/EUR');
        const livePrice = ticker.last;
        if (global.lastBtcLivePrice && livePrice < global.lastBtcLivePrice * 0.988) {
            console.log(`[BTC CROLLO IMPROVVISO] BTC da ${global.lastBtcLivePrice} a ${livePrice}`);
            return {
                allowAltBuys: false,
                regime: "CRASH_LIVE",
                btcChange24hPct: 0,
                summary: `Crollo live BTC a €${livePrice.toFixed(0)}`
            };
        }
        global.lastBtcLivePrice = livePrice;

        const ohlcv1h = await exchange.fetchOHLCV('BTC/EUR', TIMEFRAME_STRUCTURE, undefined, 30);
        if (!ohlcv1h || ohlcv1h.length < 12) {
            return { allowAltBuys: false, regime: "NO_DATA", btcChange24hPct: 0, summary: "Dati 1h BTC insufficienti" };
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

        // Sta ancora facendo nuovi minimi o scendendo pesantemente senza fermarsi?
        const makingFreshBreakdown = (lastCandle[3] < prevCandle[3] * 0.997) && (lastCandle[4] < prevCandle[4]);
        const heavyFreefall = ((lastCandle[4] - threeCandlesAgo[1]) / threeCandlesAgo[1]) * 100 < -1.4;

        // Cambio di fase / tenuta dopo discesa: ha stornato nelle 24h ma ora tiene sopra il minimo di giornata e sta rimbalzando/girando
        const isReversalOrReboundPhase =
            !makingFreshBreakdown &&
            !heavyFreefall &&
            reboundFromDayLowPct >= 0.35 &&
            (lastCandle[4] >= prevCandle[4] || btcChange24hPct > -2.5);

        const regime = isReversalOrReboundPhase
            ? (recentDropBeforeLowPct >= 1.5 ? "CAMBIO_FASE_DOPO_SCARICO" : "SPINTA_GIORNALIERA")
            : "PRESSIONE_RIBASSISTA";

        const summary = `${regime} | Prezzo €${livePrice.toFixed(0)} | 24h ${btcChange24hPct >= 0 ? '+' : ''}${btcChange24hPct.toFixed(2)}% | Min24h €${dayLow.toFixed(0)} (+${reboundFromDayLowPct.toFixed(2)}%) | Max24h €${dayHigh.toFixed(0)}`;
        console.log(`[Regime BTC] ${isReversalOrReboundPhase ? 'OK' : 'STOP'} | ${summary}`);

        return {
            allowAltBuys: isReversalOrReboundPhase,
            regime,
            btcChange24hPct,
            summary
        };
    } catch (e) {
        console.log(`[Regime BTC] Errore lettura: ${e.message}`);
        return { allowAltBuys: false, regime: "ERRORE", btcChange24hPct: 0, summary: "Errore dati BTC" };
    }
}

// VALUTA LA POSIZIONE DELLA SINGOLA ALTCOIN NELLA GIORNATA + SE STA GIRANDO SUL MINIMO
function evaluateAltDailySetup(ohlcv5m, ohlcv1h, isDailyWinner, btcRegime) {
    if (!ohlcv5m || ohlcv5m.length < 24 || !ohlcv1h || ohlcv1h.length < 12) {
        return { valid: false, score: 0, dynamicTpGrossPct: Number((BASE_TP_NET_PCT + ESTIMATED_ROUNDTRIP_FEE_PCT).toFixed(2)), reason: "Dati insufficienti" };
    }

    const closes5m = ohlcv5m.map(c => c[4]);
    const lows5m = ohlcv5m.map(c => c[3]);
    const highs5m = ohlcv5m.map(c => c[2]);
    const vols5m = ohlcv5m.map(c => c[5]);

    const currentPrice = closes5m[closes5m.length - 1];
    const prevClose = closes5m[closes5m.length - 2];

    const last24h1h = ohlcv1h.slice(-24);
    const dayLow = Math.min(...last24h1h.map(c => c[3]));
    const dayHigh = Math.max(...last24h1h.map(c => c[2]));
    const dayOpen = last24h1h[0][1];
    const dayChangePct = dayOpen > 0 ? ((currentPrice - dayOpen) / dayOpen) * 100 : 0;

    // Dove si trova il prezzo tra minimo e massimo delle 24h (0 = sul minimo, 1 = sul massimo)
    const range24h = dayHigh - dayLow;
    const positionInDayRange = range24h > 0 ? (currentPrice - dayLow) / range24h : 0.5;
    const reboundFromDayLowPct = dayLow > 0 ? ((currentPrice - dayLow) / dayLow) * 100 : 0;
    const upsideRoomToDayHighPct = currentPrice > 0 ? ((dayHigh - currentPrice) / currentPrice) * 100 : 0;

    // Minimo locale recente su 5m (ultime 18 candele = 90 min) e tenuta sopra di esso
    const recentLow5m = Math.min(...lows5m.slice(-18, -2));
    const holdingAboveLocalLow = currentPrice > recentLow5m * 1.002 && lows5m[lows5m.length - 1] >= recentLow5m * 0.998;

    // Volumi e candele recenti sul 5m: cerca conferma che non stia più scaricando ma stia girando/rimbalzando
    const avgVol = vols5m.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
    const lastVol = vols5m[vols5m.length - 1];
    const greenCandlesLast4 = [
        closes5m[closes5m.length - 1] > closes5m[closes5m.length - 2],
        closes5m[closes5m.length - 2] > closes5m[closes5m.length - 3],
        closes5m[closes5m.length - 3] > closes5m[closes5m.length - 4],
        closes5m[closes5m.length - 4] > closes5m[closes5m.length - 5]
    ].filter(Boolean).length;

    let score = 0;
    const reasons = [];

    // 1. Posizione nella giornata: favorisce zone basse/medie della giornata con spazio verso il massimo giornaliero
    if (positionInDayRange <= 0.65 && upsideRoomToDayHighPct >= 1.4) {
        score += 3.0;
        reasons.push(`Zona favorevole giornata (spazio max +${upsideRoomToDayHighPct.toFixed(1)}%)`);
    } else if (positionInDayRange > 0.85 || upsideRoomToDayHighPct < 0.9) {
        score -= 2.5;
        reasons.push("Troppo vicina al massimo di giornata");
    }

    // 2. Reazione / rimbalzo dal minimo di giornata o minimo locale 5m
    if (holdingAboveLocalLow && reboundFromDayLowPct >= 0.4) {
        score += 2.5;
        reasons.push(`Tiene sopra minimo (+${reboundFromDayLowPct.toFixed(1)}% da min24h)`);
    }

    // 3. Cambio di marcia sulle ultime candele 5m
    if (greenCandlesLast4 >= 2 && currentPrice >= prevClose) {
        score += 2.0;
        reasons.push(`Svolta 5m (${greenCandlesLast4}/4 verdi)`);
    }

    // 4. Forza giornaliera / vincente di giornata
    if (isDailyWinner || dayChangePct > 1.5) {
        score += 1.5;
        reasons.push(`Forza giornaliera (${dayChangePct >= 0 ? '+' : ''}${dayChangePct.toFixed(1)}%)`);
    }

    // 5. Volumi a supporto
    if (avgVol > 0 && lastVol >= avgVol * 1.1) {
        score += 1.0;
        reasons.push("Volumi presenti");
    }

    // Take Profit dinamico calibrato sullo spazio reale fino al massimo di giornata e sul regime BTC
    let targetNet = BASE_TP_NET_PCT;
    if (btcRegime.regime === "CAMBIO_FASE_DOPO_SCARICO") {
        targetNet += 0.45;
    }
    if (upsideRoomToDayHighPct >= 2.5) {
        targetNet += 0.55;
    } else if (upsideRoomToDayHighPct < 1.3) {
        targetNet = MIN_TP_NET_PCT;
    }
    targetNet = Math.max(MIN_TP_NET_PCT, Math.min(MAX_DYNAMIC_TP_NET_PCT, targetNet));
    const dynamicTpGrossPct = Number((targetNet + ESTIMATED_ROUNDTRIP_FEE_PCT).toFixed(2));

    const valid = score >= MIN_DAY_REBOUND_SCORE && holdingAboveLocalLow && upsideRoomToDayHighPct >= 1.1;
    return {
        valid,
        score,
        dynamicTpGrossPct,
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

                // 1. GESTIONE POSIZIONI APERTE (adattata alla giornata e alla tenuta del movimento)
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
                        try {
                            const [pos5m, pos1h] = await Promise.all([
                                exchange.fetchOHLCV(symbol, TIMEFRAME_ENTRY, undefined, 24),
                                exchange.fetchOHLCV(symbol, TIMEFRAME_STRUCTURE, undefined, 24)
                            ]);
                            const setup = evaluateAltDailySetup(pos5m, pos1h, dailyWinnersSet.has(symbol), btcRegime);
                            dynamicTpGrossPct = setup.dynamicTpGrossPct;
                        } catch (e) {}

                        let isTrailingHit = false;
                        if (peakProfitPct >= TRAILING_ARM_GROSS_PCT) {
                            const trailingStopLevel = Math.max(TRAILING_FLOOR_GROSS_PCT, peakProfitPct - TRAILING_PULLBACK_PCT);
                            if (profitPercentage <= trailingStopLevel) {
                                isTrailingHit = true;
                            }
                        }

                        const isTpHit = profitPercentage >= dynamicTpGrossPct;
                        const isStopLossHit = profitPercentage <= STOP_LOSS_FAST_CUT_PCT || btcRegime.regime === "CRASH_LIVE";
                        const isMaxTimeHit = minutesOpen >= MAX_HOLD_MINUTES && profitPercentage > ESTIMATED_ROUNDTRIP_FEE_PCT;

                        console.log(`[Posizione] ${symbol} (€${(freeCoinAmount * currentPrice).toFixed(2)}) | PnL: ${profitPercentage.toFixed(2)}% | Picco: +${peakProfitPct.toFixed(2)}% | TP: +${dynamicTpGrossPct}% | Aperta: ${minutesOpen.toFixed(0)}m`);

                        if (isTpHit || isTrailingHit || isStopLossHit || isMaxTimeHit) {
                            let reasonType = "TP DINAMICO";
                            if (btcRegime.regime === "CRASH_LIVE") reasonType = "CROLLO BTC";
                            else if (isStopLossHit) reasonType = `STOP LOSS (${STOP_LOSS_FAST_CUT_PCT}%)`;
                            else if (isTrailingHit) reasonType = `TRAILING STOP (picco +${peakProfitPct.toFixed(2)}%)`;
                            else if (isTpHit) reasonType = `TP DINAMICO (+${dynamicTpGrossPct}%)`;
                            else if (isMaxTimeHit) reasonType = `INCASSO TEMPO (${minutesOpen.toFixed(0)}m)`;

                            console.log(`[VENDITA] Chiusura (${reasonType}) su ${symbol} (PnL: ${profitPercentage.toFixed(2)}%)...`);
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

                // 3. SCANNER GIORNALIERO / CAMBIO DI FASE SULLE ALTCOIN
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

                        let targetInvestmentSize = ORDER_SIZE_EUR;
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        if (eurBalance >= ORDER_SIZE_EUR || eurBalance >= 5) {
                            const amountToBuy = targetInvestmentSize / currentPrice;
                            console.log(`[Buy Setup] Ordine da €${targetInvestmentSize} su ${symbol} (Score ${setup.score.toFixed(1)}, TP +${setup.dynamicTpGrossPct}%) a €${currentPrice}...`);

                            try {
                                await exchange.createMarketBuyOrder(symbol, amountToBuy);
                                activePositions[symbol] = {
                                    entryPrice: currentPrice,
                                    amount: amountToBuy,
                                    time: Date.now(),
                                    peakProfitPct: 0
                                };
                                lastBuyTimestamp = Date.now();
                                console.log(`[BUY OK] Acquistati €${targetInvestmentSize} di ${symbol} | ${setup.reason}`);
                                lastLog = `Acquistati €${targetInvestmentSize} di ${symbol} (TP +${setup.dynamicTpGrossPct}%)`;
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
