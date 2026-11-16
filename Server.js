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
let lastLog = "Bot avviato: Protezione Live BTC + Cacciatore Ipervenduti + Netto Fee Reali OK.";

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

async function getMacroSentiment() {
    try {
        const fngRes = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 4000 });
        const fngValue = parseInt(fngRes.data.data[0].value, 10);
        return { value: fngValue, label: fngRes.data.data[0].value_classification, isExtremeFear: fngValue <= 20 };
    } catch (e) {
        return { value: 50, label: "Neutral", isExtremeFear: false };
    }
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

                // 1. CONTROLLO LIVE TICKER DI BTC (Protezione Flash Crash)
                let isLiveFlashCrash = false;
                try {
                    const btcTicker = await exchange.fetchTicker('BTC/EUR');
                    const btcCurrentLivePrice = btcTicker.last;
                    if (global.lastBtcLivePrice && btcCurrentLivePrice < global.lastBtcLivePrice * 0.985) {
                        console.log(`[🚨 FLASH CRASH LIVE] BTC è sceso bruscamente in tempo reale a €${btcCurrentLivePrice}! Protezione immediata...`);
                        isLiveFlashCrash = true;
                    }
                    global.lastBtcLivePrice = btcCurrentLivePrice;
                } catch (e) {}

                const dynamicTakeProfit = 0.5; // TP lordo (+0.5%)

                // 2. MONITORAGGIO PORTAFOGLIO CON CALCOLO NETTO DELLE FEE
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
                            // Calcolo puntuale delle fee stimate di Kraken (circa 0.26% a transazione, 0.52% round-trip)
                            const estimatedFeePercent = 0.52; 
                            const netPnlPercent = grossPnlPercent - estimatedFeePercent;

                            console.log(`[Portafoglio] ${symbol} | Ingresso: €${entryPrice.toFixed(2)} | Attuale: €${currentPrice.toFixed(2)} | Lordo: ${grossPnlPercent.toFixed(2)}% | Netto Fee: ${netPnlPercent.toFixed(2)}%`);

                            const freeAmount = balance.free[currency] || 0;
                            if (freeAmount <= 0.0001) continue;

                            // VENDITA / ROTAZIONE (Se scatta il flash crash, il TP lordo o il taglio netto)
                            if (isLiveFlashCrash || grossPnlPercent >= dynamicTakeProfit || netPnlPercent >= 0.05 || grossPnlPercent <= -0.6) {
                                console.log(`[🔄 ROTAZIONE / CHIUSURA] Vendita in corso su ${symbol} (Lordo: ${grossPnlPercent.toFixed(2)}% | Netto: ${netPnlPercent.toFixed(2)}%)...`);
                                await exchange.createMarketSellOrder(symbol, freeAmount);
                                await new Promise(resolve => setTimeout(resolve, 5000));
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

                // 3. SCANSIONE A 360° KRAKEN + CMC & IPERVENDUTI IN RIMBALZO
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
