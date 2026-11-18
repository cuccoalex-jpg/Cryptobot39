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
let lastLog = "Bot avviato: Watchlist personalizzata + Termometro BTC (1h/4h/24h) + Stop Loss 3% + 10€.";
let focusedHotPool = [];
let lastHotPoolUpdate = 0;
global.lastBtcLivePrice = 0;

let activePositions = {};

const stablecoinsToIgnore = ['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'ZEUR', 'KFEE', 'EUR', 'ZUSD'];

const customWatchlistSymbols = [
    'ETH/EUR', 'HYPE/EUR', 'ICP/EUR', 'LDO/EUR', 'ONDO/EUR', 
    'PEPE/EUR', 'SKY/EUR', 'SOL/EUR', 'SUI/EUR', 'USUAL/EUR', 
    'WLD/EUR', 'AAVE/EUR', 'ALLO/EUR', 'BTC/EUR', 'CRV/EUR', 
    'EIGEN/EUR', 'ENA/EUR'
];

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Posizioni in Memoria Locale:</b> ${Object.keys(activePositions).length > 0 ? Object.keys(activePositions).join(', ') : 'Nessuna'}</p>
                <p><b>Watchlist Personalizzata:</b> ${focusedHotPool.length > 0 ? focusedHotPool.join(', ') : 'Sincronizzazione in corso...'}</p>
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

// VALUTAZIONE TECNICA: Anticipo sui supporti, RSI e volumi CMC
function evaluateTechnicalScore(ohlcv) {
    if (!ohlcv || ohlcv.length < 20) return { score: 0, details: "Dati insufficienti" };

    const closes = ohlcv.map(c => c[4]);
    const lows = ohlcv.map(c => c[3]);
    const volumes = ohlcv.map(c => c[5]);
    
    const currentClose = closes[closes.length - 1];
    
    let score = 0;
    let reasons = [];

    const rsi = calculateRSI(closes, 14);

    // Test Supporti e Bollinger Inferiore (Ingresso anticipato sui minimi)
    const recentLow = Math.min(...lows.slice(-10, -1));
    const bollinger = calculateBollingerBands(closes);

    if (currentClose <= recentLow * 1.015 || currentClose <= bollinger.lower * 1.01) {
        score += 4.0;
        reasons.push("Test Supporto / Fondo Bollinger (Anticipo)");
    }

    if (rsi >= 35 && rsi <= 68) {
        score += 2.5;
        reasons.push(`RSI Dinamico (${rsi.toFixed(1)})`);
    }

    const avgVolume = volumes.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
    const lastVolume = volumes[volumes.length - 1];
    if (lastVolume > avgVolume * 1.15) {
        score += 2.0;
        reasons.push("Volumi in Crescita");
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

                // 1. TERMOMETRO BTC (1h, 4h, 24h) + FLASH CRASH
                let isLiveFlashCrash = false;
                try {
                    const btcTicker = await exchange.fetchTicker('BTC/EUR');
                    const btcCurrentLivePrice = btcTicker.last;
                    if (global.lastBtcLivePrice && btcCurrentLivePrice < global.lastBtcLivePrice * 0.985) {
                        console.log(`[FLASH CRASH] BTC a €${btcCurrentLivePrice}! Chiusura d'emergenza attivata.`);
                        isLiveFlashCrash = true;
                    }
                    global.lastBtcLivePrice = btcCurrentLivePrice;
                } catch (e) {}

                let isBtcBullish = false;
                try {
                    const btcOhlcv1h = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 20);
                    const btcCloses1h = btcOhlcv1h.map(c => c[4]);
                    const btcPrice = btcCloses1h[btcCloses1h.length - 1];
                    const btcOpen1h = btcOhlcv1h[btcOhlcv1h.length - 1][1];
                    const btcChange1h = ((btcPrice - btcOpen1h) / btcOpen1h) * 100;

                    const btcOhlcv4h = await exchange.fetchOHLCV('BTC/EUR', '4h', undefined, 10);
                    const btcCloses4h = btcOhlcv4h.map(c => c[4]);
                    const btcOpen4h = btcOhlcv4h[btcOhlcv4h.length - 1][1];
                    const btcChange4h = ((btcPrice - btcOpen4h) / btcOpen4h) * 100;

                    const btcOhlcv1d = await exchange.fetchOHLCV('BTC/EUR', '1d', undefined, 5);
                    const btcCloses1d = btcOhlcv1d.map(c => c[4]);
                    const btcOpen1d = btcOhlcv1d[btcOhlcv1d.length - 1][1];
                    const btcChange24h = ((btcPrice - btcOpen1d) / btcOpen1d) * 100;

                    isBtcBullish = (btcChange1h > -0.1 && btcChange4h >= -0.3 && btcChange24h >= -2.0 && !isLiveFlashCrash);
                    console.log(`[Termometro BTC] 1h: ${btcChange1h.toFixed(2)}% | 4h: ${btcChange4h.toFixed(2)}% | 24h: ${btcChange24h.toFixed(2)}% | Bullish: ${isBtcBullish}`);
                } catch (btcErr) {
                    isBtcBullish = true;
                }

                const targetTakeProfitLordo = 1.12; 
                const thresholdStopLoss = -3.0; // Stop Loss dinamico al 3%

                const totalBalances = balance.total || {};
                const assetKeys = Object.keys(totalBalances).filter(rawCurrency => {
                    if (stablecoinsToIgnore.includes(rawCurrency)) return false;
                    const amt = totalBalances[rawCurrency] || 0;
                    if (amt <= 0.0001) return false;
                    let clean = rawCurrency.replace(/^[XZ]/, '');
                    if (clean === 'XBT') clean = 'BTC';
                    return !stablecoinsToIgnore.includes(clean);
                });

                // 2. GESTIONE PORTAFOGLIO (TP, Stop Loss 3% e Time-Stop a 2.5 ore)
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
                        const hoursOpen = (Date.now() - entryTime) / (1000 * 60 * 60);

                        const isStagnant = (hoursOpen > 2.5 && profitPercentage > -0.5 && profitPercentage < 0.3);
                        const isStopLossHit = (profitPercentage <= thresholdStopLoss || isLiveFlashCrash);
                        const isTpValid = profitPercentage >= targetTakeProfitLordo;

                        console.log(`[Wallet] ${symbol} | Ingresso: €${entryPrice.toFixed(4)} | Attuale: €${currentPrice.toFixed(4)} | PnL: ${profitPercentage.toFixed(2)}% | Ore: ${hoursOpen.toFixed(1)}h`);

                        const freeCoinAmount = balance.free[rawCurrency] || balance.free[cleanCurrency] || balance.free[`X${cleanCurrency}`] || balance.free[`Z${cleanCurrency}`] || 0;
                        if (freeCoinAmount <= 0.0001) continue;

                        if (isTpValid || isStopLossHit || isStagnant) {
                            const reasonType = isTpValid ? "TAKE PROFIT (+1.12%)" : (isStopLossHit ? "STOP LOSS (-3%)" : "TAGLIO STAGNAZIONE (2.5h)");
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

                // 3. SINCRONIZZAZIONE WATCHLIST + VOLUMI CMC
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
                    console.log(`[Focus] Watchlist personalizzata ordinata per volumi CMC: ${focusedHotPool.join(', ')}`);
                }

                if (!isBtcBullish) {
                    console.log(`[Attesa] Termometro BTC non favorevole. Bot in pausa.`);
                    await new Promise(resolve => setTimeout(resolve, 30000));
                    continue;
                }

                // 4. SCANNER SULLA WATCHLIST CON IMPORTO A 10€
                for (const symbol of focusedHotPool) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        
                        const baseCurrency = symbol.split('/')[0];
                        if (balance.total[baseCurrency] && balance.total[baseCurrency] > 0.0001) continue; 
                        const rawKey = Object.keys(balance.total).find(k => k.includes(baseCurrency));
                        if (rawKey && balance.total[rawKey] > 0.0001) continue;

                        const ohlcv5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 20);
                        const techEval = evaluateTechnicalScore(ohlcv5m);
                        
                        if (techEval.score < 4.0) continue; 

                        let targetInvestmentSize = 10; // Importo fisso a 10€
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        if (eurBalance >= 10 || eurBalance >= 5) {
                            const currentPrice = ohlcv5m[ohlcv5m.length - 1][4];
                            const amountToBuy = targetInvestmentSize / currentPrice;
                            
                            console.log(`[Tentativo Buy] Ordine da €${targetInvestmentSize} su ${symbol} (Anticipo Supporto) a €${currentPrice}...`);
                            
                            try {
                                const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                                
                                activePositions[symbol] = {
                                    entryPrice: currentPrice,
                                    amount: amountToBuy,
                                    time: Date.now()
                                };

                                console.log(`[BUY OK - Score ${techEval.score}] Acquistati €${targetInvestmentSize} di ${symbol} a €${currentPrice.toFixed(4)} | Motivi: ${techEval.details}`);
                                lastLog = `Acquistati €${targetInvestmentSize} di ${symbol}`;
                                
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

        await new Promise(resolve => setTimeout(resolve, 30000));
    }
}

app.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
    setTimeout(() => {
        runBotLoop();
    }, 3000);
});
