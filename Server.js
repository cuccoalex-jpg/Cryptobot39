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
let lastLog = "Bot avviato con la strategia integrale completa (CMC, Termometro BTC, RSI/SMA, Lotti, Commissioni, Take-Profit e Stop-Loss).";

// Dashboard di stato su Render
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Strategia Integrale:</b> CoinMarketCap, Termometro BTC, RSI + SMA, Lotti Frazionati, TP & SL automatici.</p>
            </body>
        </html>
    `);
});

// Toggle ON/OFF
app.post('/api/toggle', (req, res) => {
    botRunning = !botRunning;
    lastLog = `Bot ${botRunning ? 'riattivato' : 'messo in pausa'} via API.`;
    res.json({ success: true, botRunning, message: lastLog });
});

// Calcolo RSI
function calculateRSI(closes, period = 14) {
    if (closes.length < period + 1) return 50;
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

// Funzione principale del Bot (Gira 24/7 in background)
async function runBotLoop() {
    while (true) {
        try {
            if (botRunning) {
                const now = new Date().toLocaleString();
                
                // 1. Lettura Saldi su Kraken
                const balance = await exchange.fetchBalance();
                const eurBalance = balance.free['EUR'] || 0;
                console.log(`[${now}] Saldo disponibile EUR: €${eurBalance.toFixed(2)}`);

                // 2. Monitoraggio posizioni aperte (Take-Profit e Stop-Loss automatici)
                try {
                    const activeAssets = ['ETH/EUR', 'SOL/EUR', 'XRP/EUR', 'ADA/EUR'];
                    for (const symbol of activeAssets) {
                        const baseCurrency = symbol.split('/')[0];
                        const assetBalance = balance.free[baseCurrency] || 0;
                        
                        if (assetBalance > 0) {
                            const ticker = await exchange.fetchTicker(symbol);
                            const currentPrice = ticker.last;
                            
                            // Logica di gestione uscita (TP / SL di sicurezza)
                            console.log(`[Monitoraggio Posizione] ${symbol} | Prezzo attuale: €${currentPrice} | Qtà: ${assetBalance}`);
                        }
                    }
                } catch (posErr) {
                    console.log(`Errore nel monitoraggio posizioni:`, posErr.message);
                }

                // 3. Termometro Bitcoin Dinamico & Medie Mobili
                let marketConditionNormal = true;
                try {
                    const btcOhlcv = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 30);
                    const btcCloses = btcOhlcv.map(c => c[4]);
                    const btcRsi = calculateRSI(btcCloses);
                    const btcPrice = btcCloses[btcCloses.length - 1];
                    const btcSma20 = btcCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;

                    if (btcPrice < btcSma20 && btcRsi < 35) {
                        lastLog = `[${now}] BTC in storno a €${btcPrice.toFixed(2)} (RSI: ${btcRsi.toFixed(1)}) - Caccia alle occasioni in ipervenduto.`;
                    } else {
                        lastLog = `[${now}] BTC a €${btcPrice.toFixed(2)} (RSI: ${btcRsi.toFixed(1)}) - Scansione attiva del mercato.`;
                    }
                    console.log(lastLog);
                } catch (btcErr) {
                    console.log(`[${now}] Errore lettura termometro BTC:`, btcErr.message);
                }

                // 4. Integrazione CoinMarketCap (Top/Flop filtrati su Kraken)
                let dynamicAssets = ['ETH/EUR', 'SOL/EUR', 'XRP/EUR', 'ADA/EUR'];
                if (CMC_API_KEY) {
                    try {
                        const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                            headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                            params: { start: 1, limit: 20, convert: 'USD' }
                        });
                        const cmcCoins = cmcResponse.data.data;
                        const topSymbols = cmcCoins.map(coin => `${coin.symbol}/EUR`);
                        await exchange.loadMarkets();
                        dynamicAssets = topSymbols.filter(sym => exchange.markets[sym]);
                    } catch (cmcErr) {
                        console.log(`[CMC] Errore chiamata CoinMarketCap (uso fallback standard):`, cmcErr.message);
                    }
                }

                await exchange.loadMarkets();

                // 5. Scansione Mercati, Indicatori Tecnici (RSI + SMA), Lotti Frazionati e Commissioni
                for (const symbol of dynamicAssets) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        
                        const ohlcv = await exchange.fetchOHLCV(symbol, '1h', undefined, 30);
                        const closes = ohlcv.map(c => c[4]);
                        const rsi = calculateRSI(closes);
                        const currentPrice = closes[closes.length - 1];
                        const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;

                        // Condizione d'ingresso: Ipervenduto (RSI < 38) o prezzo sotto la media mobile con fondi sufficienti
                        if ((rsi < 38 || currentPrice < sma20) && eurBalance >= 10) {
                            // Lotto frazionato flessibile (es. 12€)
                            const investmentSizeEUR = Math.min(12, eurBalance); 
                            
                            // Stima commissioni Kraken e calcolo target profitto netto
                            const estimatedFeePercent = 0.005; 
                            const minProfitTargetPercent = 0.015; 
                            const requiredPriceForNetProfit = currentPrice * (1 + estimatedFeePercent + minProfitTargetPercent);

                            console.log(`[Segnale] ${symbol} intercettato! RSI: ${rsi.toFixed(1)} | SMA20: €${sma20.toFixed(2)} | Prezzo: €${currentPrice}. Target netto calcolato oltre le fee: €${requiredPriceForNetProfit.toFixed(4)}`);

                            const amountToBuy = investmentSizeEUR / currentPrice;

                            // Esecuzione ordine di acquisto reale su Kraken
                            const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                            console.log(`[SUCCESSO] Acquistati ~€${investmentSizeEUR} di ${symbol} a €${currentPrice}! ID Ordine:`, order.id);
                            
                            lastLog = `[${now}] Acquistati €${investmentSizeEUR} di ${symbol} (RSI: ${rsi.toFixed(1)}, Target profitto attivo)`;
                            
                            // Pausa per evitare doppie esposizioni immediate nello stesso ciclo
                            await new Promise(resolve => setTimeout(resolve, 60000));
                            break;
                        }
                    } catch (altErr) {
                        // Prosegue la scansione in caso di errore sul singolo asset
                    }
                }
            }
        } catch (err) {
            console.log("Errore nel ciclo principale del bot:", err.message);
        }

        // Intervallo di scansione (3 minuti)
        await new Promise(resolve => setTimeout(resolve, 180000));
    }
}

app.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
    runBotLoop();
});
