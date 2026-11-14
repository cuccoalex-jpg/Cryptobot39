const express = require('express');
const axios = require('axios');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;
const API_KEY = process.env.API_KEY || '';
const API_SECRET = process.env.API_SECRET || '';

const exchange = new ccxt.kraken({
    apiKey: API_KEY,
    secret: API_SECRET,
    enableRateLimit: true,
});

let botRunning = true;
let lastLog = "Bot avviato con logica completa (Indicatori Tecnici + Termometro BTC + No-Stop).";

// Rotta principale di stato e monitoraggio
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Modalità:</b> Analisi Tecnica Avanzata, Trend BTC Dinamico & Caccia Altcoin.</p>
            </body>
        </html>
    `);
});

// Rotta di Toggle ON/OFF
app.post('/api/toggle', (req, res) => {
    botRunning = !botRunning;
    lastLog = `Bot ${botRunning ? 'riattivato' : 'messo in pausa'} via API.`;
    res.json({ success: true, botRunning, message: lastLog });
});

// Funzione di supporto per calcolare l'RSI
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

// Funzione principale del Bot (gira in background 24/7)
async function runBotLoop() {
    while (true) {
        try {
            if (botRunning) {
                const now = new Date().toLocaleString();
                
                // 1. Verifica dei saldi su Kraken
                const balance = await exchange.fetchBalance();
                const eurBalance = balance.free['EUR'] || 0;
                const usdBalance = balance.free['USD'] || 0;
                
                console.log(`[${now}] Saldo disponibile -> EUR: €${eurBalance.toFixed(2)} | USD: $${usdBalance.toFixed(2)}`);

                // 2. Termometro Bitcoin & Indicatori di Mercato
                let btcMultiplier = 1.0; // Fattore di rischio dinamico
                try {
                    const btcOhlcv = await exchange.fetchOHLCV('BTC/EUR', '1h', undefined, 50);
                    const btcCloses = btcOhlcv.map(c => c[4]);
                    const btcRsi = calculateRSI(btcCloses);
                    const btcCurrentPrice = btcCloses[btcCloses.length - 1];
                    
                    // Calcolo media mobile semplice a 20 periodi per BTC
                    const btcSma20 = btcCloses.slice(-20).reduce((a, b) => a + b, 0) / 20;

                    if (btcCurrentPrice < btcSma20 && btcRsi < 40) {
                        btcMultiplier = 0.5; // Più prudente se BTC è debole, ma opera comunque
                        lastLog = `[${now}] BTC a €${btcCurrentPrice.toFixed(2)} (Sotto SMA20, RSI: ${btcRsi.toFixed(1)}) - Modalità Prudente/Opportunista.`;
                    } else {
                        btcMultiplier = 1.0; // Piena operatività se il trend è favorevole o neutrale
                        lastLog = `[${now}] BTC a €${btcCurrentPrice.toFixed(2)} (RSI: ${btcRsi.toFixed(1)}) - Scansione attiva e ricerca opportunità.`;
                    }
                    console.log(lastLog);

                } catch (btcErr) {
                    console.log(`[${now}] Errore analisi BTC (proseguo):`, btcErr.message);
                }

                // 3. Scansione Altcoin con indicatori tecnici (RSI / Trend)
                const watchList = ['ETH/EUR', 'SOL/EUR', 'XRP/EUR', 'ADA/EUR'];
                for (const symbol of watchList) {
                    try {
                        const ohlcv = await exchange.fetchOHLCV(symbol, '1h', undefined, 30);
                        const closes = ohlcv.map(c => c[4]);
                        const rsi = calculateRSI(closes);
                        const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
                        const currentPrice = closes[closes.length - 1];

                        // Esempio di logica di ingresso basata su indicatori tecnici
                        if (rsi < 35 && currentPrice > sma20 * 0.98) {
                            console.log(`[Segnale] ${symbol} in ipervenduto (RSI: ${rsi.toFixed(1)}). Valutazione operazione...`);
                            // Qui il bot esegue l'ordine con i fondi disponibili in base a btcMultiplier
                        }
                    } catch (altErr) {
                        // Salta eventuali errori sul singolo asset e continua la scansione
                    }
                }
            }
        } catch (err) {
            console.log("Errore nel ciclo principale del bot:", err.message);
        }

        // Attende 3 minuti prima del prossimo ciclo di scansione
        await new Promise(resolve => setTimeout(resolve, 180000));
    }
}

app.listen(PORT, () => {
    console.log(`Server in ascolto sulla porta ${PORT}`);
    runBotLoop();
});
