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
let lastLog = "Bot avviato: Versione Definitiva Unificata (Tutte le funzioni attive).";
let watchedOutperformers = [];
global.lastBtcLivePrice = 0;

// Lista di stablecoin o asset fiat equivalenti da ignorare completamente
const stablecoinsToIgnore = ['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'ZEUR', 'KFEE'];

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Watchlist Rotazione / Kraken:</b> ${watchedOutperformers.length > 0 ? watchedOutperformers.join(', ') : 'Sincronizzazione in corso...'}</p>
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

                // 1. CONTROLLO LIVE TICKER DI BTC (Protezione Flash Crash in tempo reale)
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

                // 2. TERMOMETRO MACRO & TREND DI BITCOIN
                let isBtcBullish = false;
                try {
                    const btcOhlcv1h = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 20);
                    const btcCloses1h = btcOhlcv1h.map(c => c[4]);
                    const btcPrice = btcCloses1h[btcCloses1h.length - 1];
                    const btcOpen1h = btcOhlcv1h[btcOhlcv1h.length - 1][1];
                    const btcChange1h = ((btcPrice - btcOpen1h) / btcOpen1h) * 100;

                    isBtcBullish = (btcChange1h > -0.5 && !isLiveFlashCrash);
                    console.log(`[Termometro BTC] Prezzo: €${btcPrice.toFixed(2)} | Variazione 1h: ${btcChange1h.toFixed(2)}% | Trend Bullish: ${isBtcBullish ? 'SI' : 'NO'}`);
                } catch (btcErr) {
                    isBtcBullish = false;
                }

                // SOGLIE OPERATIVE DEFINITIVE
                const dynamicTakeProfit = 1.2;  // TP Lordo per utile netto reale
                const fastCutThreshold = -0.3;  // Taglio immediato allo -0.3% reale per liberare la cassa

                // 3. MONITORAGGIO PORTAFOGLIO & GESTIONE USCITE / FAST-CUT
                const totalBalances = balance.total || {};
                for (const currency of Object.keys(totalBalances)) {
                    if (stablecoinsToIgnore.includes(currency)) continue;
                    let cleanCurrency = currency.replace(/^X/, '').replace(/^Z/, '');
                    if (cleanCurrency === 'XBT') cleanCurrency = 'BTC';
                    if (stablecoinsToIgnore.includes(cleanCurrency)) continue;

                    const totalAmount = balance.total[currency] || 0;
                    if (totalAmount > 0.0001) {
                        const symbol = `${cleanCurrency}/EUR`;
                        if (!exchange.markets[symbol]) continue;

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

                            const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;

                            console.log(`[Portafoglio] ${symbol} | Ingresso: €${entryPrice.toFixed(2)} | Attuale: €${currentPrice.toFixed(2)} | PnL Reale: ${grossPnlPercent.toFixed(2)}%`);

                            const freeAmount = balance.free[currency] || 0;
                            if (freeAmount <= 0.0001) continue;

                            // USCITA AUTOMATICA (Flash Crash, TP raggiunto o Fast-Cut immediato)
                            if (isLiveFlashCrash || grossPnlPercent >= dynamicTakeProfit || grossPnlPercent <= fastCutThreshold) {
                                const reason = isLiveFlashCrash ? "Flash Crash Live" : (grossPnlPercent <= fastCutThreshold ? "⚡ Fast-Cut (-0.3%)" : "Take-Profit Raggiunto");
                                console.log(`[🔄 ROTAZIONE] Vendita in corso su ${symbol} | Motivo: ${reason} (Variazione: ${grossPnlPercent.toFixed(2)}%)...`);
                                
                                await exchange.createMarketSellOrder(symbol, freeAmount);
                                await new Promise(resolve => setTimeout(resolve, 3000));
                                continue;
                            }
                        } catch (errPort) {
                            console.log(`Errore portafoglio ${symbol}:`, errPort.message);
                        }
                    }
                }

                if (isLiveFlashCrash) {
                    await new Promise(resolve => setTimeout(resolve, 30000));
                    continue;
                }

                // 4. SCANSIONE A 360° KRAKEN + CMC & IPERVENDUTI IN RIMBALZO (OVERSOLD BOUNCE)
                let allKrakenPairs = Object.keys(exchange.markets).filter(symbol => {
                    if (!symbol.endsWith('/EUR') || !exchange.markets[symbol].active) return false;
                    const base = symbol.split('/')[0].replace(/^X/, '').replace(/^Z/, '');
                    return !stablecoinsToIgnore.includes(base);
                });
                
                allKrakenPairs = shuffleArray(allKrakenPairs);

                let cmcTopMovers = [];
                if (CMC_API_KEY) {
                    try {
                        const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                            headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                            params: { start: 1, limit: 300, sort: 'percent_change_24h', sort_dir: 'desc', convert: 'EUR' }
                        });
                        for (const coin of cmcResponse.data.data) {
                            const baseSym = coin.symbol;
                            if (stablecoinsToIgnore.includes(baseSym)) continue;
                            const change24h = coin.quote?.EUR?.percent_change_24h || 0;
                            if (change24h > 0) {
                                const sym = `${baseSym}/EUR`;
                                if (exchange.markets[sym] && exchange.markets[sym].active) {
                                    cmcTopMovers.push(sym);
                                }
                            }
                        }
                    } catch (e) {}
                }

                let prioritizedAssets = [...new Set([...cmcTopMovers, ...allKrakenPairs])];
                watchedOutperformers = prioritizedAssets.slice(0, 10);

                for (const symbol of prioritizedAssets) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        
                        const baseCurrency = symbol.split('/')[0];
                        if (balance.free[baseCurrency] && balance.free[baseCurrency] > 0.0001) continue; 

                        const ohlcv5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 30);
                        const closes5m = ohlcv5m.map(c => c[4]);
                        const currentPrice = closes5m[closes5m.length - 1];
                        
                        const rsi5m = calculateRSI(closes5m, 14);
                        const prevRsi5m = calculateRSI(closes5m.slice(0, -1), 14);
                        const { isGreenCandle } = detectChartPatterns(ohlcv5m);

                        // CACCIATORE DI IPERVENDUTI IN RIMBALZO + CANDELA VERDE
                        const isOversoldRebound = (prevRsi5m <= 35 && rsi5m > prevRsi5m && isGreenCandle);

                        if (!isGreenCandle && !isOversoldRebound) continue;

                        let targetInvestmentSize = 5; 
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        if (eurBalance >= 5) {
                            const reason = isOversoldRebound ? "Oversold Bounce (Rimbalzo Ipervenduto 🚀)" : "Candela Verde Attiva";
                            console.log(`[🚀 NUOVO INGRESSO] Acquisto su ${symbol} | Motivo: ${reason} | Prezzo: €${currentPrice}`);
                            
                            const amountToBuy = targetInvestmentSize / currentPrice;
                            const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                            console.log(`[SUCCESSO] Acquistati €${targetInvestmentSize} di ${symbol}! ID:`, order.id);
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
