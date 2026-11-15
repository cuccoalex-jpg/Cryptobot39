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
let lastLog = "Bot avviato: Scansione e monitoraggio totale e dinamico su tutte le coppie crypto (Senza limiti fissi, gestione automatica di qualsiasi asset aperto).";

// Dashboard di stato su Render
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Strategia Totale:</b> Scansione universale su tutto il mercato, monitoraggio automatico di qualsiasi asset in portafoglio (DOT, ATOM, ecc.) e operatività elastica.</p>
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

// Calcolo RSI sicuro
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

// Calcolo Media Mobile (SMA) sicuro
function calculateSMA(closes, period) {
    if (!closes || closes.length < period) return closes ? closes[closes.length - 1] : 0;
    const slice = closes.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
}

// Rilevamento Supporti e Resistenze geometriche avanzate
function findSupportAndResistance(ohlcv) {
    if (!ohlcv || ohlcv.length < 20) return { support: 0, resistance: 0 };
    const lows = ohlcv.map(c => c[3]); 
    const highs = ohlcv.map(c => c[2]); 
    const support = Math.min(...lows.slice(-20)); 
    const resistance = Math.max(...highs.slice(-20)); 
    return { support, resistance };
}

// Rilevamento Pattern di Prezzo
function detectChartPatterns(ohlcv) {
    if (!ohlcv || ohlcv.length < 15) return { pattern: "NONE", score: 0 };
    
    const closes = ohlcv.map(c => c[4]);
    const highs = ohlcv.map(c => c[2]);
    const lows = ohlcv.map(c => c[3]);
    
    let pattern = "NORMAL_ACTION";
    let score = 0;

    const currentClose = closes[closes.length - 1];
    const recentMin = Math.min(...lows.slice(-10));
    
    if (Math.abs(currentClose - recentMin) / recentMin < 0.01) {
        pattern = "SUPPORT_BOUNCE";
        score += 2;
    }

    const p = highs.slice(-15);
    const mid = Math.floor(p.length / 2);
    if (p[mid] > p[0] && p[mid] > p[p.length - 1] && p[mid] > p[mid - 2] && p[mid] > p[mid + 2]) {
        pattern = "HEAD_AND_SHOULDERS_FORMING";
        score += 3;
    }

    return { pattern, score };
}

// Funzione principale del Bot (Gira 24/7 in background)
async function runBotLoop() {
    while (true) {
        try {
            if (botRunning) {
                const now = new Date().toLocaleString();
                await exchange.loadMarkets();

                // 1. Lettura Saldi su Kraken (in EUR)
                const balance = await exchange.fetchBalance();
                const eurBalance = balance.free['EUR'] || 0;
                console.log(`[${now}] Saldo disponibile EUR: €${eurBalance.toFixed(2)}`);

                // 2. Termometro BTC (Indicatore di rischio, non bloccante)
                let isBtcBullish = true;
                try {
                    const btcOhlcv = await exchange.fetchOHLCV('BTC/EUR', '15m', undefined, 50);
                    const btcCloses = btcOhlcv.map(c => c[4]);
                    const btcRsi = calculateRSI(btcCloses);
                    const btcPrice = btcCloses[btcCloses.length - 1];
                    const btcSma20 = calculateSMA(btcCloses, 20);

                    isBtcBullish = (btcPrice >= btcSma20);

                    lastLog = `[${now}] BTC a €${btcPrice.toFixed(2)} (RSI: ${btcRsi.toFixed(1)}) | Trend Macro: ${isBtcBullish ? 'BULLISH' : 'BEARISH (Operativo elastico)'}`;
                    console.log(lastLog);
                } catch (btcErr) {
                    console.log(`[${now}] Errore termometro BTC:`, btcErr.message);
                }

                // Soglie SL e TP dinamiche in base al trend di BTC
                const dynamicStopLoss = isBtcBullish ? -5.0 : -2.0;    
                const dynamicTakeProfit = isBtcBullish ? 2.0 : 1.0;     

                // 3. COSTRUZIONE DINAMICA DEL PANIERE DI SCANSIONE E MONITORAGGIO
                // Raccoglie TUTTE le coppie in EUR disponibili su Kraken
                let allKrakenPairs = Object.keys(exchange.markets).filter(symbol => symbol.endsWith('/EUR') && exchange.markets[symbol].active);

                // Se abbiamo la chiave di CoinMarketCap, filtriamo e ordiniamo in base ai top token mondiali
                let dynamicAssets = allKrakenPairs;
                if (CMC_API_KEY) {
                    try {
                        const cmcResponse = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
                            headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
                            params: { start: 1, limit: 100, convert: 'USD' }
                        });
                        const cmcCoins = cmcResponse.data.data;
                        const topSymbols = cmcCoins.map(coin => `${coin.symbol}/EUR`);
                        // Mette in cima i top di CoinMarketCap che esistono su Kraken, e in coda gli altri presenti su Kraken
                        const validCmcAssets = topSymbols.filter(sym => exchange.markets[sym] && exchange.markets[sym].active);
                        const remainingPairs = allKrakenPairs.filter(sym => !validCmcAssets.includes(sym));
                        dynamicAssets = [...validCmcAssets, ...remainingPairs];
                    } catch (cmcErr) {}
                }

                // 4. MONITORAGGIO AUTOMATICO DI TUTTI GLI ASSET ATTUALMENTE POSSEDUTI (Inclusi DOT, ATOM, ecc.)
                for (const symbol of dynamicAssets) {
                    try {
                        const baseCurrency = symbol.split('/')[0];
                        const assetBalance = balance.free[baseCurrency] || 0;
                        
                        // Se possiedi una quantità di questo asset sul conto, il bot lo sorveglia per applicare TP e SL
                        if (assetBalance > 0.0001) {
                            const ticker = await exchange.fetchTicker(symbol);
                            const currentPrice = ticker.last;

                            let entryPrice = currentPrice;
                            try {
                                const trades = await exchange.fetchMyTrades(symbol, undefined, 5);
                                const buyTrades = trades.filter(t => t.side === 'buy');
                                if (buyTrades.length > 0) {
                                    entryPrice = buyTrades[buyTrades.length - 1].price;
                                }
                            } catch (e) {}

                            const pnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
                            console.log(`[Posizione Aperta] ${symbol} | Ingresso: €${entryPrice.toFixed(2)} | Attuale: €${currentPrice.toFixed(2)} | P&L: ${pnlPercent.toFixed(2)}% [SL: ${dynamicStopLoss}%, TP: ${dynamicTakeProfit}%]`);

                            if (pnlPercent >= dynamicTakeProfit) {
                                console.log(`[TAKE-PROFIT] Target raggiunto su ${symbol} (+${pnlPercent.toFixed(2)}%). Vendita in corso...`);
                                const sellOrder = await exchange.createMarketSellOrder(symbol, assetBalance);
                                console.log(`[SUCCESSO VENDITA] TP eseguito su ${symbol}! ID:`, sellOrder.id);
                                lastLog = `[${now}] Take-Profit eseguito su ${symbol} (+${pnlPercent.toFixed(2)}%)`;
                                await new Promise(resolve => setTimeout(resolve, 60000));
                                break;
                            } else if (pnlPercent <= dynamicStopLoss) {
                                console.log(`[STOP-LOSS] Soglia di protezione raggiunta su ${symbol} (${pnlPercent.toFixed(2)}%). Chiusura in corso...`);
                                const sellOrder = await exchange.createMarketSellOrder(symbol, assetBalance);
                                console.log(`[SUCCESSO STOP-LOSS] SL eseguito su ${symbol}! ID:`, sellOrder.id);
                                lastLog = `[${now}] Stop-Loss eseguito su ${symbol} (${pnlPercent.toFixed(2)}%)`;
                                await new Promise(resolve => setTimeout(resolve, 60000));
                                break;
                            }
                        }
                    } catch (posErr) {
                        console.log(`Errore monitoraggio ${symbol}:`, posErr.message);
                    }
                }

                // 5. ANALISI ROTAZIONALE SU TUTTO IL MERCATO (Senza restrizioni a liste fisse)
                for (const symbol of dynamicAssets) {
                    try {
                        if (!exchange.markets[symbol]) continue;
                        
                        // EVITA ACCANIMENTO: Salta l'asset se ne possediamo già una quantità
                        const baseCurrency = symbol.split('/')[0];
                        if (balance.free[baseCurrency] && balance.free[baseCurrency] > 0.0001) {
                            continue; 
                        }

                        const ohlcv5m = await exchange.fetchOHLCV(symbol, '5m', undefined, 30);
                        const ohlcv15m = await exchange.fetchOHLCV(symbol, '15m', undefined, 30);
                        const ohlcv1h = await exchange.fetchOHLCV(symbol, '1h', undefined, 30);

                        const closes5m = ohlcv5m.map(c => c[4]);
                        const closes15m = ohlcv15m.map(c => c[4]);
                        const closes1h = ohlcv1h.map(c => c[4]);

                        const rsi5m = calculateRSI(closes5m);
                        const rsi15m = calculateRSI(closes15m);
                        const currentPrice = closes5m[closes5m.length - 1];

                        const { support, resistance } = findSupportAndResistance(ohlcv15m);
                        const { pattern, score } = detectChartPatterns(ohlcv15m);

                        // Taglia dell'investimento: 5€ in Bearish, 12€ in Bullish
                        let targetInvestmentSize = isBtcBullish ? 12 : 5; 
                        if (eurBalance < targetInvestmentSize) targetInvestmentSize = eurBalance;

                        // CRITERI DI INGRESSO FLESSIBILI (Cerca opportunità ovunque sul mercato)
                        const nearSupport = support > 0 && (currentPrice <= support * 1.02);
                        const isOversold = (rsi5m < 32 || rsi15m < 38);
                        const strongMomentum = (rsi5m > 60 && currentPrice >= resistance * 0.98);

                        let buyCondition = false;
                        let reason = "";

                        if (!isBtcBullish) {
                            if (nearSupport || isOversold || score >= 2) {
                                buyCondition = (eurBalance >= 5);
                                reason = nearSupport ? "Test Supporto (Agile Bearish)" : "Ipervenduto / Rimbalzo";
                            }
                        } else {
                            if (strongMomentum || nearSupport || isOversold) {
                                buyCondition = (eurBalance >= 5);
                                reason = strongMomentum ? "Slancio / Forza (Bullish)" : "Supporto / Sconto (Bullish)";
                            }
                        }

                        if (buyCondition) {
                            const estimatedFeePercent = 0.005; 
                            const netTargetPrice = currentPrice * (1 + estimatedFeePercent + (dynamicTakeProfit / 100));

                            console.log(`[Scansione Totale] Trovata occasione su ${symbol} | Motivo: ${reason} | RSI(5m): ${rsi5m.toFixed(1)} | Supporto: €${support.toFixed(2)} | Prezzo: €${currentPrice}`);

                            const amountToBuy = targetInvestmentSize / currentPrice;
                            const order = await exchange.createMarketBuyOrder(symbol, amountToBuy);
                            
                            console.log(`[SUCCESSO ACQUISTO] Acquistati ~€${targetInvestmentSize} di ${symbol} a €${currentPrice} (${reason})! ID:`, order.id);
                            lastLog = `[${now}] Acquistati €${targetInvestmentSize} di ${symbol} (${reason})`;
                            
                            await new Promise(resolve => setTimeout(resolve, 60000));
                            break;
                        }
                    } catch (altErr) {
                        // Passa all'asset successivo in caso di errore o coppia illiquida
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
