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
let lastLog = "Bot avviato: Timeframe 15m + Termometro BTC + Filtro News CMC + Fast Cut (10€).";
let focusedHotPool = [];
let lastHotPoolUpdate = 0;
global.lastBtcLivePrice = 0;

let activePositions = {};

const stablecoinsToIgnore = ['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'ZEUR', 'KFEE', 'EUR', 'ZUSD'];

// Watchlist senza ETH
const customWatchlistSymbols = [
    'HYPE/EUR', 'ICP/EUR', 'LDO/EUR', 'ONDO/EUR',
    'PEPE/EUR', 'SKY/EUR', 'SOL/EUR', 'SUI/EUR', 'USUAL/EUR',
    'WLD/EUR', 'AAVE/EUR', 'ALLO/EUR', 'BTC/EUR', 'CRV/EUR',
    'EIGEN/EUR', 'ENA/EUR'
];

// Soglie regolabili del Termometro BTC
const BTC_FLASH_CRASH_DROP_RATIO = 0.985; // -1.5% tra due letture live
const BTC_MAX_DROP_1H_PERCENT = -2.0;    // Blocca nuovi acquisti se BTC scende oltre -2.0% sull'ultima ora

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

// TERMOMETRO BTC: flash crash live + variazione ultima ora
async function evaluateBtcThermometer() {
    let isLiveFlashCrash = false;
    let isBtcHealthy = true;
    let btcChange1h = 0;

    try {
        const btcTicker = await exchange.fetchTicker('BTC/EUR');
        const btcCurrentLivePrice = btcTicker.last;
        if (global.lastBtcLivePrice && btcCurrentLivePrice < global.lastBtcLivePrice * BTC_FLASH_CRASH_DROP_RATIO) {
            console.log(`[FLASH CRASH] BTC a €${btcCurrentLivePrice}! Sospensione totale.`);
            isLiveFlashCrash = true;
        }
        global.lastBtcLivePrice = btcCurrentLivePrice;
    } catch (e) {}

    try {
        const btcOhlcv1h = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 4);
        if (btcOhlcv1h && btcOhlcv1h.length >= 2) {
            const lastCandle = btcOhlcv1h[btcOhlcv1h.length - 1];
            btcChange1h = ((lastCandle[4] - lastCandle[1]) / lastCandle[1]) * 100;
            if (btcChange1h < BTC_MAX_DROP_1H_PERCENT || isLiveFlashCrash) {
                isBtcHealthy = false;
            }
        }
    } catch (btcErr) {
        isBtcHealthy = true;
    }

    return { isLiveFlashCrash, isBtcHealthy, btcChange1h };
}

// VALUTAZIONE TECNICA SU 15 MINUTI
function evaluateTechnicalScore15m(ohlcv) {
    if (!ohlcv || ohlcv.length < 22) return { score: 0, details: "Dati insufficienti" };

    const closes = ohlcv.map(c => c[4]);
    const lows = ohlcv.map(c => c[3]);
    const volumes = ohlcv.map(c => c[5]);

    const currentClose = closes[closes.length - 1];
    const prevClose = closes[closes.length - 2];
    const prevLow = lows[lows.length - 2];

    let score = 0;
    let reasons = [];

    const rsi = calculateRSI(closes, 14);
    const prevRsi = calculateRSI(closes.slice(0, -1), 14);
    const bollinger = calculateBollingerBands(closes);

    const recentLow = Math.min(...lows.slice(-10, -2));
    const testedSupportAndReacted = (prevLow <= recentLow * 1.008) && (currentClose > prevClose);
    const lowerBollingerReaction = (currentClose <= bollinger.lower * 1.01) && (currentClose > prevClose);

    if (testedSupportAndReacted || lowerBollingerReaction) {
        score += 3.5;
        reasons.push("Reazione 15m su Supporto/Bollinger");
    }

    if (rsi >= 32 && rsi <= 62 && rsi > prevRsi) {
        score += 2.0;
        reasons.push(`RSI 15m in Risalita (${prevRsi.toFixed(1)} -> ${rsi.toFixed(1)})`);
    }

    const avgVolume = volumes.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
    const lastVolume = volumes[volumes.length - 1];

    if (lastVolume > avgVolume * 1.25 && currentClose > prevClose) {
        score += 2.5;
        reasons.push("Volumi 15m Sopra Media");
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
                    await new Promise(resolve => setTimeout(resolve, 60000));
                    continue;
                }

                // 1. TERMOMETRO BTC
                const btcThermometer = await evaluateBtcThermometer();
                const { isLiveFlashCrash, isBtcHealthy, btcChange1h } = btcThermometer;

                const targetTakeProfitLordo = 1.12;
                const thresholdStopLoss = -1.0;

                const totalBalances = balance.total || {};
                const assetKeys = Object.keys(totalBalances).filter(rawCurrency => {
                    if (stablecoinsToIgnore.includes(rawCurrency)) return false;
                    const amt = totalBalances[rawCurrency] || 0;
                    if (amt <= 0.0001) return false;
                    let clean = rawCurrency.replace(/^[XZ]/, '');
                    if (clean === 'XBT') clean = 'BTC';
                    return !stablecoinsToIgnore.includes(clean);
                });

                // 2. GESTIONE PORTAFOGLIO
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

                        const profitPercentage = ((currentPrice - entryPrice) / entryPrice) * 100;
                        const minutesOpen = (Date.now() - entryTime) / (1000 * 60);

                        const isStagnant = (minutesOpen > 45 && profitPercentage > -0.4 && profitPercentage < 0.4);
                        const isStopLossHit = (profitPercentage <= thresholdStopLoss || isLiveFlashCrash);
                        const isTpValid = profitPercentage >= targetTakeProfitLordo;

                        console.log(`[Wallet] ${symbol} | Ingresso: €${entryPrice.toFixed(4)} | Attuale: €${currentPrice.toFixed(4)} | PnL: ${profitPercentage.toFixed(2)}% | Min: ${minutesOpen.toFixed(0)}m`);

                        const freeCoinAmount = balance.free[rawCurrency] || balance.free[cleanCurrency] || balance.free[`X${cleanCurrency}`] || balance.free[`Z${cleanCurrency}`] || 0;
                        if (freeCoinAmount <= 0.0001) continue;

                        if (isTpValid || isStopLossHit || isStagnant) {
                            const reasonType = isTpValid ? "TAKE PROFIT (+1.12% lordo)" : (isStopLossHit ? "STOP LOSS (-1.0%)" : "TIME-STOP (45m)");
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

                // 3. SINCRONIZZAZIONE WATCHLIST ORDINATA PER VOLUMI CMC
                const currentTime = Date.now();
                if (focusedHotPool.length === 0 || (currentTime - lastHotPoolUpdate > 10 * 60 * 1000)) {
                    let validatedWatchlist = [];
                    for (const sym of customWatchlistSymbols) {
                        if (exchange.markets[sym] && exchange.markets[sym].active) {
                            validatedWatchlist.push(sym);
                        }
                    }

                    if (CMC_API_KEY) {
                        try {
                            const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                                headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                                params: { start: 1, limit: 100, sort: 'volume_24h', sort_dir: 'desc', convert: 'EUR' }
                            });
                            validatedWatchlist.sort((a, b) => {
                                const baseA = a.split('/')[0];
                                const baseB = b.split('/')[0];
                                const coinA = cmcResponse.data.data.find(c => c.symbol === baseA);
                                const coinB = cmcResponse.data.data.find(c => c.symbol === baseB);
                                const volA = coinA ? coinA.quote.EUR.volume_24h : 0;
                                const volB = coinB ? coinB.quote.EUR.volume_24h : 0;
                                return volB - volA;
                            });
                        } catch (e) {}
                    }

                    focusedHotPool = validatedWatchlist;
                    lastHotPoolUpdate = currentTime;
                    console.log(`[Focus] Watchlist ordinata per volumi CMC: ${focusedHotPool.join(', ')}`);
                }

                if (!isBtcHealthy) {
                    console.log(`[Termometro BTC] 1h ${btcChange1h.toFixed(2)}% (soglia ${BTC_MAX_DROP_1H_PERCENT}%). Nuovi acquisti in pausa.`);
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
                        const techEval = evaluateTechnicalScore15m(ohlcv15m);

                        if (techEval.score < 5.5) continue;

                        let targetInvestmentSize = 10;
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        if (eurBalance >= 10 || eurBalance >= 5) {
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
