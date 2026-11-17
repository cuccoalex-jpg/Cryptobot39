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
let lastLog = "Bot avviato: Clean Build v4 - Portafoglio Universale + TP 0.6% Netto + Fast-Cut -0.3%.";
let watchedOutperformers = [];
let focusedHotPool = [];
let lastHotPoolUpdate = 0;
global.lastBtcLivePrice = 0;

// Lista di stablecoin o asset fiat equivalenti da ignorare completamente
const stablecoinsToIgnore = ['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'ZEUR', 'KFEE', 'EUR', 'ZUSD'];

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Watchlist Attiva:</b> ${watchedOutperformers.length > 0 ? watchedOutperformers.join(', ') : 'Sincronizzazione in corso...'}</p>
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

function detectChartPatterns(ohlcv) {
    if (!ohlcv || ohlcv.length < 15) return { score: 0, isGreenCandle: false };
    const lastCandle = ohlcv[ohlcv.length - 1];
    const isGreenCandle = lastCandle[4] > lastCandle[1];
    const closes = ohlcv.map(c => c[4]);
    const lows = ohlcv.map(c => c[3]);
    let score = 0;
    const currentClose = closes[closes.length - 1];
    const recentMin = Math.min(...lows.slice(-10));
    if (Math.abs(currentClose - recentMin) / recentMin < 0.01 && isGreenCandle) {
        score += 3;
    }
    return { score, isGreenCandle };
}

async function runBotLoop() {
    while (true) {
        try {
            if (botRunning) {
                const now = new Date().toLocaleString();
                await exchange.loadMarkets();

                const balance = await exchange.fetchBalance();
                const eurBalance = balance.free['EUR'] || balance.free['ZEUR'] || 0;
                console.log(`[${now}] Saldo disponibile EUR: €${eurBalance.toFixed(2)}`);

                // 1. CONTROLLO LIVE TICKER DI BTC (Protezione Flash Crash in tempo reale)[span_0](start_span)[span_0](end_span)
                let isLiveFlashCrash = false;
                try {
                    const btcTicker = await exchange.fetchTicker('BTC/EUR');
                    const btcCurrentLivePrice = btcTicker.last;
                    if (global.lastBtcLivePrice && btcCurrentLivePrice < global.lastBtcLivePrice * 0.985) {
                        console.log(`[🚨 FLASH CRASH LIVE] BTC è sceso a €${btcCurrentLivePrice}! Protezione d'emergenza attiva.`);
                        isLiveFlashCrash = true;
                    }
                    global.lastBtcLivePrice = btcCurrentLivePrice;
                } catch (e) {}

                // 2. TERMOMETRO MACRO & TREND DI BITCOIN (Logica Adattiva)
                let isBtcBullish = false;
                try {
                    const btcOhlcv1h = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 20);
                    const btcCloses1h = btcOhlcv1h.map(c => c[4]);
                    const btcPrice = btcCloses1h[btcCloses1h.length - 1];
                    const btcOpen1h = btcOhlcv1h[btcOhlcv1h.length - 1][1];
                    const btcChange1h = ((btcPrice - btcOpen1h) / btcOpen1h) * 100;

                    isBtcBullish = (btcChange1h > 0.2 && !isLiveFlashCrash);
                    console.log(`[Termometro BTC] Prezzo: €${btcPrice.toFixed(2)} | Variazione 1h: ${btcChange1h.toFixed(2)}% | Trend Bullish: ${isBtcBullish ? 'SI (Rally)' : 'NO (Incerto / Top Pump)'}`);
                } catch (btcErr) {
                    isBtcBullish = false;
                }

                // SOGLIE OPERATIVE DI FERRO
                const targetTakeProfitLordo = 1.12;  // 1.12% lordo per garantirti lo 0.6% netto pulito[span_1](start_span)[span_1](end_span)
                const thresholdFastCut = -0.3;       // Taglio immediato allo -0.3% reale[span_2](start_span)[span_2](end_span)

                // 3. MONITORAGGIO UNIVERSALE PORTAFOGLIO & CHIUSURA FORZATA
                const totalBalances = balance.total || {};
                let activePositionsCount = 0;

                for (const rawCurrency of Object.keys(totalBalances)) {
                    if (stablecoinsToIgnore.includes(rawCurrency)) continue;

                    const totalAmount = balance.total[rawCurrency] || 0;
                    if (totalAmount <= 0.0001) continue;

                    let cleanCurrency = rawCurrency.replace(/^[XZ]/, '');
                    if (cleanCurrency === 'XBT') cleanCurrency = 'BTC';
                    if (stablecoinsToIgnore.includes(cleanCurrency)) continue;

                    let symbol = `${cleanCurrency}/EUR`;
                    if (!exchange.markets[symbol]) {
                        symbol = `${rawCurrency}/EUR`;
                        if (!exchange.markets[symbol]) continue;
                    }

                    activePositionsCount++;

                    try {
                        const ticker = await exchange.fetchTicker(symbol);
                        const currentPrice = ticker.last;

                        let entryPrice = currentPrice;
                        try {
                            const trades = await exchange.fetchMyTrades(symbol, undefined, 10);
                            const buyTrades = trades.filter(t => t.side === 'buy');
                            if (buyTrades.length > 0) {
                                entryPrice = buyTrades[buyTrades.length - 1].price;
                            }
                        } catch (e) {}

                        const profitPercentage = ((currentPrice - entryPrice) / entryPrice) * 100;

                        console.log(`[Portafoglio Check] ${symbol} | Ingresso: €${entryPrice.toFixed(2)} | Attuale: €${currentPrice.toFixed(2)} | PnL Lordo: ${profitPercentage.toFixed(2)}% (Target: +1.12%)`);

                        const freeCoinAmount = balance.free[rawCurrency] || balance.free[cleanCurrency] || balance.free[`X${cleanCurrency}`] || balance.free[`Z${cleanCurrency}`] || 0;
                        if (freeCoinAmount <= 0.0001) continue;

                        const isTakeProfitValid = profitPercentage >= targetTakeProfitLordo;
                        const isFastCutValid = profitPercentage <= thresholdFastCut;

                        if (isLiveFlashCrash || isTakeProfitValid || isFastCutValid) {
                            let closeReason = "🎯 Take-Profit Netto (+0.6%) Raggiunto";[span_3](start_span)[span_3](end_span)
                            if (isLiveFlashCrash) closeReason = "🚨 Flash Crash Live";
                            else if (isFastCutValid) closeReason = "⚡ Fast-Cut (-0.3% Lotto)";[span_4](start_span)[span_4](end_span)

                            console.log(`[🔄 VENDITA AUTOMATICA] Esecuzione chiusura su ${symbol} | Motivo: ${closeReason} | PnL: ${profitPercentage.toFixed(2)}%...`);[span_5](start_span)[span_5](end_span)
                            
                            const sellResultOrder = await exchange.createMarketSellOrder(symbol, freeCoinAmount);
                            console.log(`[SUCCESSO VENDITA] Posizione ${symbol} chiusa correttamente! ID Ordine:`, sellResultOrder.id);
                            lastLog = `[${now}] Chiusura ${symbol} (${closeReason}) - PnL: ${profitPercentage.toFixed(2)}%`;
                            
                            await new Promise(resolve => setTimeout(resolve, 5000));
                            continue;
                        }
                    } catch (errPortLoop) {
                        console.log(`[AVVISO PORTAFOGLIO] Impossibile elaborare ${symbol}:`, errPortLoop.message);
                    }
                }

                if (isLiveFlashCrash) {
                    await new Promise(resolve => setTimeout(resolve, 30000));
                    continue;
                }

                // 4. SELEZIONE DINAMICA ADATTIVA (Top Asset se BTC è incerto / Watchlist se in Rally)
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
                            const sortParam = isBtcBullish ? 'volume_24h' : 'percent_change_24h';
                            const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                                headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                                params: { start: 1, limit: 100, sort: sortParam, sort_dir: 'desc', convert: 'EUR' }
                            });
                            for (const coin of cmcResponse.data.data) {
                                const baseSym = coin.symbol;
                                if (stablecoinsToIgnore.includes(baseSym)) continue;
                                const change24h = coin.quote?.EUR?.percent_change_24h || 0;
                                if (!isBtcBullish && change24h <= 0) continue; 

                                const sym = `${baseSym}/EUR`;
                                if (exchange.markets[sym] && exchange.markets[sym].active) {
                                    cmcTopMovers.push(sym);
                                }
                            }
                        } catch (e) {}
                    }

                    if (!isBtcBullish) {
                        console.log(`[🛡️ MODALITÀ DIFENSIVA / TOP PUMP] BTC incerto: scansione mirata esclusivamente sui top asset che pompano.`);[span_6](start_span)[span_6](end_span)
                        focusedHotPool = cmcTopMovers.slice(0, 37);
                        if (focusedHotPool.length < 10) {
                            focusedHotPool = [...new Set([...cmcTopMovers, ...shuffleArray(krakenPairs)])].slice(0, 37);
                        }
                    } else {
                        console.log(`[🚀 MODALITÀ RALLY] BTC Bullish: attivata watchlist standard a 37 asset caldi.`);
                        let combinedPool = [...new Set([...cmcTopMovers, ...shuffleArray(krakenPairs)])];
                        focusedHotPool = combinedPool.slice(0, 37);
                    }

                    watchedOutperformers = focusedHotPool.slice(0, 10);
                    lastHotPoolUpdate = currentTime;
                }

                // 5. APERTURA NUOVI LOTTI SULLA WATCHLIST MIRATA
                for (const symbol of focusedHotPool) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        
                        const baseCurrency = symbol.split('/')[0];
                        if (balance.total[baseCurrency] && balance.total[baseCurrency] > 0.0001) continue; 
                        const rawKey = Object.keys(balance.total).find(k => k.includes(baseCurrency));
                        if (rawKey && balance.total[rawKey] > 0.0001) continue;

                        const ohlcv5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 30);
                        const closes5m = ohlcv5m.map(c => c[4]);
                        const currentPrice = closes5m[closes5m.length - 1];
                        
                        const rsi5m = calculateRSI(closes5m, 14);
                        const prevRsi5m = calculateRSI(closes5m.slice(0, -1), 14);
                        const bollinger = calculateBollingerBands(closes5m);
                        const { isGreenCandle } = detectChartPatterns(ohlcv5m);

                        const isOversoldRebound = (prevRsi5m <= 35 && rsi5m > prevRsi5m && isGreenCandle);
                        const isSidewaysBounce = (bollinger.isSideways && currentPrice <= bollinger.lower * 1.01 && isGreenCandle);

                        if (!isGreenCandle && !isOversoldRebound && !isSidewaysBounce) continue;

                        let targetInvestmentSize = 5; 
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        if (eurBalance >= 5) {
                            const reason = isOversoldRebound ? "Oversold Bounce (Rimbalzo Ipervenduto 🚀)" : (isSidewaysBounce ? "Mercato Laterale / Supporto Bollinger 📊" : "Candela Verde Attiva");
                            console.log(`[🚀 NUOVO LOTTO] Apertura su ${symbol} | Motivo: ${reason} | Prezzo: €${currentPrice}`);
                            
                            const amountToBuy = targetInvestmentSize / currentPrice;
                            const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                            console.log(`[SUCCESSO] Acquistati €${targetInvestmentSize} di ${symbol} (Lotto n. ${activePositionsCount + 1})! ID:`, order.id);
                            lastLog = `[${now}] Acquistati €${targetInvestmentSize} di ${symbol} (${reason})`;
                            await new Promise(resolve => setTimeout(resolve, 15000));
                            break;
                        }
                    } catch (altErr) {}
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
