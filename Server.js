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
let lastLog = "Bot avviato con gestione integrale attiva (Acquisto, Take-Profit e Stop-Loss reali).";

// Dashboard di stato su Render
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Modalità:</b> Esecuzione reale attiva (Acquisto in ipervenduto + TP & SL automatici).</p>
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
                
                await exchange.loadMarkets();

                // 1. Lettura Saldi su Kraken
                const balance = await exchange.fetchBalance();
                const eurBalance = balance.free['EUR'] || 0;
                console.log(`[${now}] Saldo disponibile EUR: €${eurBalance.toFixed(2)}`);

                // 2. Monitoraggio posizioni aperte per Take-Profit e Stop-Loss effettivi
                const activeAssets = ['ETH/EUR', 'SOL/EUR', 'XRP/EUR', 'ADA/EUR'];
                for (const symbol of activeAssets) {
                    try {
                        const baseCurrency = symbol.split('/')[0];
                        const assetBalance = balance.free[baseCurrency] || 0;
                        
                        // Se possediamo una quantità di questo asset superiore al dust
                        if (assetBalance > 0.0001 && exchange.markets[symbol]) {
                            const ticker = await exchange.fetchTicker(symbol);
                            const currentPrice = ticker.last;

                            // Recupera l'ultimo prezzo di acquisto dallo storico degli scambi su Kraken
                            let entryPrice = currentPrice; // Fallback di sicurezza
                            try {
                                const trades = await exchange.fetchMyTrades(symbol, undefined, 5);
                                const buyTrades = trades.filter(t => t.side === 'buy');
                                if (buyTrades.length > 0) {
                                    entryPrice = buyTrades[buyTrades.length - 1].price;
                                }
                            } catch (tradeErr) {
                                // Se non recupera lo storico, usa il prezzo corrente come riferimento iniziale
                            }

                            const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
                            console.log(`[Posizione Aperta] ${symbol} | Qtà: ${assetBalance} | Prezzo Ingresso: €${entryPrice.toFixed(2)} | Prezzo Attuale: €${currentPrice.toFixed(2)} | P&L: ${pnlPercent.toFixed(2)}%`);

                            // Soglie di gestione rischio
                            const takeProfitThreshold = 2.0; // +2% di utile netto target
                            const stopLossThreshold = -4.0;  // -4% di perdita massima tollerata

                            if (pnlPercent >= takeProfitThreshold) {
                                console.log(`[TAKE-PROFIT] Raggiunto il target del +${takeProfitThreshold}% su ${symbol}! Esecuzione vendita a mercato...`);
                                const sellOrder = await exchange.createMarketSellOrder(symbol, assetBalance);
                                console.log(`[SUCCESSO VENDITA] Ordine TP eseguito! ID:`, sellOrder.id);
                                lastLog = `[${now}] Take-Profit eseguito su ${symbol} con successo (+${pnlPercent.toFixed(2)}%)`;
                                await new Promise(resolve => setTimeout(resolve, 60000));
                                break;
                            } else if (pnlPercent <= stopLossThreshold) {
                                console.log(`[STOP-LOSS] Raggiunta la soglia di protezione del ${stopLossThreshold}% su ${symbol}. Chiusura posizione in corso...`);
                                const sellOrder = await exchange.createMarketSellOrder(symbol, assetBalance);
                                console.log(`[SUCCESSO STOP-LOSS] Ordine SL eseguito! ID:`, sellOrder.id);
                                lastLog = `[${now}] Stop-Loss eseguito su ${symbol} (${pnlPercent.toFixed(2)}%)`;
                                await new Promise(resolve => setTimeout(resolve, 60000));
                                break;
                            }
                        }
                    } catch (posErr) {
                        console.log(`Errore nel monitoraggio posizione su ${symbol}:`, posErr.message);
                    }
                }

                // 3. Termometro Bitcoin Dinamico & Medie Mobili
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
                        dynamicAssets = topSymbols.filter(sym => exchange.markets[sym]);
                    } catch (cmcErr) {
                        // Fallback sulla lista standard in caso di errore CMC
                    }
                }

                // 5. Scansione Mercati, Indicatori Tecnici (RSI + SMA) e Lotti Frazionati in Acquisto
                for (const symbol of dynamicAssets) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        
                        const ohlcv = await exchange.fetchOHLCV(symbol, '1h', undefined, 30);
                        const closes = ohlcv.map(c => c[4]);
                        const rsi = calculateRSI(closes);
                        const currentPrice = closes[closes.length - 1];
                        const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;

                        // Condizione d'ingresso: Ipervenduto (RSI < 38) o prezzo sotto la media mobile con almeno 10€ disponibili
                        if ((rsi < 38 || currentPrice < sma20) && eurBalance >= 10) {
                            const investmentSizeEUR = Math.min(12, eurBalance); // Lotto frazionato da 12€

                            console.log(`[Segnale Acquisto] ${symbol} intercettato! RSI: ${rsi.toFixed(1)} | SMA20: €${sma20.toFixed(2)} | Prezzo: €${currentPrice}`);

                            const amountToBuy = investmentSizeEUR / currentPrice;

                            // Esecuzione ordine di acquisto reale su Kraken
                            const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                            console.log(`[SUCCESSO ACQUISTO] Acquistati ~€${investmentSizeEUR} di ${symbol} a €${currentPrice}! ID:`, order.id);
                            
                            lastLog = `[${now}] Acquistati €${investmentSizeEUR} di ${symbol} (RSI: ${rsi.toFixed(1)})`;
                            
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
