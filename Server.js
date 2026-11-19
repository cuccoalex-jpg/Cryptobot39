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
let lastLog = "Bot avviato: Approccio Prudente 15m + TP Dinamico + Watchlist CMC (10€).";
let focusedHotPool = [];
let dailyWinnersSet = new Set();
let lastHotPoolUpdate = 0;
global.lastBtcLivePrice = 0;

let activePositions = {};

const stablecoinsToIgnore = ['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'ZEUR', 'KFEE', 'EUR', 'ZUSD'];

// Watchlist richiesta (senza ETH; Cronos -> CRO; coppie non attive su Kraken vengono filtrate in automatico)
const customWatchlistSymbols = [
    'PEPE/EUR', 'SUI/EUR', 'SKI/EUR', 'SOL/EUR', 'HYPE/EUR',
    'AAVE/EUR', 'ALLO/EUR', 'WLD/EUR', 'NEAR/EUR', 'SEI/EUR',
    'LINK/EUR', 'GM/EUR', 'CRO/EUR', 'MNT/EUR', 'GRT/EUR',
    'UNI/EUR', 'ENA/EUR'
];

// Parametri prudenti e TP dinamico
const ORDER_SIZE_EUR = 10;
const ESTIMATED_ROUNDTRIP_FEE_PCT = 0.50; // Stima fee andata/ritorno + spread (regolabile)
const BASE_TP_NET_PCT = 0.85;             // Target netto base -> ~1.35% lordo con 0.50% fee
const EXTENDED_TP_NET_PCT = 1.60;         // Target netto esteso se il rimbalzo/struttura è ampio -> ~2.10% lordo
const STOP_LOSS_FAST_CUT_PCT = -1.0;      // Fast-cut / stop loss prudente
const TIME_STOP_MINUTES = 60;             // 4 candele da 15m prima di valutare la stagnazione
const MIN_ENTRY_SCORE_15M = 6.5;

// Termometro BTC prudente
const BTC_FLASH_CRASH_DROP_RATIO = 0.985; // -1.5% live
const BTC_MAX_DROP_1H_PERCENT = -0.8;    // -0.8% su ultima candela 1h
const BTC_MAX_DROP_3H_PERCENT = -1.5;    // -1.5% su 3 ore

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Posizioni in Memoria Locale:</b> ${Object.keys(activePositions).length > 0 ? Object.keys(activePositions).join(', ') : 'Nessuna'}</p>
                <p><b>Watchlist Attiva (15m):</b> ${focusedHotPool.length > 0 ? focusedHotPool.join(', ') : 'Sincronizzazione in corso...'}</p>
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

// TERMOMETRO BTC PRUDENTE
async function evaluateBtcThermometer() {
    let isLiveFlashCrash = false;
    let isBtcHealthy = true;
    let btcChange1h = 0;
    let btcChange3h = 0;
    let blockReason = "";

    try {
        const btcTicker = await exchange.fetchTicker('BTC/EUR');
        const btcCurrentLivePrice = btcTicker.last;
        if (global.lastBtcLivePrice && btcCurrentLivePrice < global.lastBtcLivePrice * BTC_FLASH_CRASH_DROP_RATIO) {
            console.log(`[FLASH CRASH] BTC a €${btcCurrentLivePrice}! Sospensione totale.`);
            isLiveFlashCrash = true;
            blockReason = "Flash Crash live";
        }
        global.lastBtcLivePrice = btcCurrentLivePrice;
    } catch (e) {}

    try {
        const btcOhlcv1h = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 5);
        if (btcOhlcv1h && btcOhlcv1h.length >= 4) {
            const lastCandle = btcOhlcv1h[btcOhlcv1h.length - 1];
            const prevCandle = btcOhlcv1h[btcOhlcv1h.length - 2];
            const candle3hAgo = btcOhlcv1h[btcOhlcv1h.length - 4];

            btcChange1h = ((lastCandle[4] - lastCandle[1]) / lastCandle[1]) * 100;
            btcChange3h = ((lastCandle[4] - candle3hAgo[1]) / candle3hAgo[1]) * 100;

            const isStillDropping = (btcChange1h < -0.5) && (lastCandle[4] < prevCandle[4]);

            if (isLiveFlashCrash) {
                isBtcHealthy = false;
            } else if (btcChange1h < BTC_MAX_DROP_1H_PERCENT) {
                isBtcHealthy = false;
                blockReason = `Calo 1h ${btcChange1h.toFixed(2)}% < ${BTC_MAX_DROP_1H_PERCENT}%`;
            } else if (btcChange3h < BTC_MAX_DROP_3H_PERCENT) {
                isBtcHealthy = false;
                blockReason = `Calo 3h ${btcChange3h.toFixed(2)}% < ${BTC_MAX_DROP_3H_PERCENT}%`;
            } else if (isStillDropping) {
                isBtcHealthy = false;
                blockReason = `BTC in discesa continua (1h ${btcChange1h.toFixed(2)}%)`;
            }
        }
    } catch (btcErr) {
        isBtcHealthy = true;
    }

    return { isLiveFlashCrash, isBtcHealthy, btcChange1h, btcChange3h, blockReason };
}

// CALCOLO TP DINAMICO (in % lordo, tenendo conto delle fee stimate)
function computeDynamicTakeProfitGrossPct(ohlcv15m, isBtcHealthy, isDailyWinner) {
    let targetNet = BASE_TP_NET_PCT;

    if (ohlcv15m && ohlcv15m.length >= 10) {
        const closes = ohlcv15m.map(c => c[4]);
        const lows = ohlcv15m.map(c => c[3]);
        const volumes = ohlcv15m.map(c => c[5]);

        const currentClose = closes[closes.length - 1];
        const swingLow = Math.min(...lows.slice(-8));
        const swingAmplitudePct = swingLow > 0 ? ((currentClose - swingLow) / swingLow) * 100 : 0;

        const avgVol = volumes.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
        const lastVol = volumes[volumes.length - 1];
        const strongVolume = avgVol > 0 && lastVol >= avgVol * 1.4;

        // Se c'è un rimbalzo/escursione già ampia (> 1.4%) con volumi forti o vincente di giornata e BTC sano, estende il target
        if (isBtcHealthy && ((swingAmplitudePct >= 1.4 && strongVolume) || (isDailyWinner && swingAmplitudePct >= 1.2))) {
            targetNet = EXTENDED_TP_NET_PCT;
        }
    }

    return Number((targetNet + ESTIMATED_ROUNDTRIP_FEE_PCT).toFixed(2));
}

// VALUTAZIONE TECNICA PRUDENTE SU 15 MINUTI
function evaluateTechnicalScore15m(ohlcv, isDailyWinnerOversold = false) {
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
        reasons.push("Reazione Verde 15m su Supporto/Bollinger");
    } else {
        score -= 2.0;
    }

    if (isDailyWinnerOversold && rsi <= 45 && rsi > prevRsi && isGreenReaction) {
        score += 2.5;
        reasons.push(`Vincenti Giornata in Scarico/Ipervenduto 15m (RSI ${prevRsi.toFixed(1)} -> ${rsi.toFixed(1)})`);
    } else if (rsi >= 34 && rsi <= 58 && rsi > prevRsi + 1.0) {
        score += 2.0;
        reasons.push(`RSI 15m in Girata (${prevRsi.toFixed(1)} -> ${rsi.toFixed(1)})`);
    }

    const avgVolume = volumes.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
    const lastVolume = volumes[volumes.length - 1];

    if (lastVolume > avgVolume * 1.3 && isGreenReaction) {
        score += 2.5;
        reasons.push("Volumi 15m Confermati");
    } else if (lastVolume < avgVolume * 0.9) {
        score -= 2.0;
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
                    await new Promise(resolve => setTimeout(resolve, 60000));
                    continue;
                }

                // 1. TERMOMETRO BTC PRUDENTE
                const btcThermometer = await evaluateBtcThermometer();
                const { isLiveFlashCrash, isBtcHealthy, btcChange1h, btcChange3h, blockReason } = btcThermometer;

                const totalBalances = balance.total || {};
                const assetKeys = Object.keys(totalBalances).filter(rawCurrency => {
                    if (stablecoinsToIgnore.includes(rawCurrency)) return false;
                    const amt = totalBalances[rawCurrency] || 0;
                    if (amt <= 0.0001) return false;
                    let clean = rawCurrency.replace(/^[XZ]/, '');
                    if (clean === 'XBT') clean = 'BTC';
                    return !stablecoinsToIgnore.includes(clean);
                });

                // 2. GESTIONE PORTAFOGLIO CON TP DINAMICO
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

                        let dynamicTpGross = Number((BASE_TP_NET_PCT + ESTIMATED_ROUNDTRIP_FEE_PCT).toFixed(2));
                        try {
                            const posOhlcv = await exchange.fetchOHLCV(symbol, '15m', undefined, 15);
                            dynamicTpGross = computeDynamicTakeProfitGrossPct(posOhlcv, isBtcHealthy, dailyWinnersSet.has(symbol));
                        } catch (e) {}

                        const profitPercentage = ((currentPrice - entryPrice) / entryPrice) * 100;
                        const minutesOpen = (Date.now() - entryTime) / (1000 * 60);

                        const isStagnant = (minutesOpen > TIME_STOP_MINUTES && profitPercentage > -0.4 && profitPercentage < 0.45);
                        const isStopLossHit = (profitPercentage <= STOP_LOSS_FAST_CUT_PCT || isLiveFlashCrash);
                        const isTpValid = profitPercentage >= dynamicTpGross;

                        console.log(`[Wallet] ${symbol} | Ingresso: €${entryPrice.toFixed(4)} | Attuale: €${currentPrice.toFixed(4)} | PnL: ${profitPercentage.toFixed(2)}% | TP Din: +${dynamicTpGross}% | Min: ${minutesOpen.toFixed(0)}m`);

                        const freeCoinAmount = balance.free[rawCurrency] || balance.free[cleanCurrency] || balance.free[`X${cleanCurrency}`] || balance.free[`Z${cleanCurrency}`] || 0;
                        if (freeCoinAmount <= 0.0001) continue;

                        if (isTpValid || isStopLossHit || isStagnant) {
                            const reasonType = isTpValid ? `TP DINAMICO (+${dynamicTpGross}% lordo)` : (isStopLossHit ? `STOP LOSS (${STOP_LOSS_FAST_CUT_PCT}%)` : `TIME-STOP (${TIME_STOP_MINUTES}m)`);
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
                    console.log(`[Termometro BTC BLOCCATO] ${blockReason} (1h: ${btcChange1h.toFixed(2)}%, 3h: ${btcChange3h.toFixed(2)}%). Nuovi acquisti sospesi.`);
                    await new Promise(resolve => setTimeout(resolve, 30000));
                    continue;
                }

                // 4. SCANNER SU CANDELA 15M CON IMPORTO A 10€
                for (const symbol of focusedHotPool) {
                    try {
                        if (!exchange.markets[symbol]) continue;

                        const baseCurrency = symbol.split('/')[0];
                        if (balance.total[baseCurrency] && balance.total[baseCurrency] > 0.0001) continue;
                        const rawKey = Object.keys(balance.total).find(k => k.includes(baseCurrency));
                        if (rawKey && balance.total[rawKey] > 0.0001) continue;

                        const ohlcv15m = await exchange.fetchOHLCV(symbol, '15m', undefined, 25);
                        const isDailyWinnerOversold = dailyWinnersSet.has(symbol);
                        const techEval = evaluateTechnicalScore15m(ohlcv15m, isDailyWinnerOversold);

                        if (techEval.score < MIN_ENTRY_SCORE_15M) continue;

                        let targetInvestmentSize = ORDER_SIZE_EUR;
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        if (eurBalance >= ORDER_SIZE_EUR || eurBalance >= 5) {
                            const currentPrice = ohlcv15m[ohlcv15m.length - 1][4];
                            const amountToBuy = targetInvestmentSize / currentPrice;

                            console.log(`[Tentativo Buy 15m] Ordine da €${targetInvestmentSize} su ${symbol} (Score ${techEval.score}) a €${currentPrice}...`);

                            try {
                                const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);

                                activePositions[symbol] = {
                                    entryPrice: currentPrice,
                                    amount: amountToBuy,
                                    time: Date.now()
                                };

                                console.log(`[BUY 15M OK - Score ${techEval.score}] Acquistati €${targetInvestmentSize} di ${symbol} a €${currentPrice.toFixed(4)} | Motivi: ${techEval.details}`);
                                lastLog = `Acquistati €${targetInvestmentSize} di ${symbol} (15m Score ${techEval.score})`;

                                await new Promise(resolve => setTimeout(resolve, 5000));
                                break;
                            } catch (orderErr) {
                                console.log(`[ERRORE ORDINE KRAKEN su ${symbol}]:`, orderErr.message);
                            }
                        }
                    } catch (altErr) {
                        console.log(`[Errore ciclo altcoin 15m]:`, altErr.message);
                    }
                }
            }
        } catch (err) {
            console.log("Errore nel ciclo principale:", err.message);
        }

        await new Promise(resolve => setTimeout(resolve, 30000));
    }
}

app.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
    setTimeout(() => {
        runBotLoop();
    }, 3000);
});
