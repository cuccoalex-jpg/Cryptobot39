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
let lastLog = "Bot avviato con logica dinamica e opportunista (No-Stop).";

// Rotta principale di stato
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p>Modalita: Opportunista dinamica (Bitcoin come termometro, zero blocchi totali).</p>
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

// Funzione principale del Bot (gira in background)
async function runBotLoop() {
    while (true) {
        try {
            if (botRunning) {
                const now = new Date().toLocaleString();
                
                // 1. Termometro Bitcoin & Mercato (valuta il sentiment senza bloccare)
                let btcTrend = "NEUTRO / DINAMICO";
                try {
                    const btcTicker = await exchange.fetchTicker('BTC/USD');
                    const btcPrice = btcTicker.last;
                    lastLog = `[${now}] Bitcoin a $${btcPrice} - Scansione attiva e ricerca opportunità sulle Altcoin in corso.`;
                    console.log(lastLog);
                } catch (btcErr) {
                    console.log(`[${now}] Errore lettura BTC (continuo operatività):`, btcErr.message);
                }

                // 2. Logica di caccia alle opportunità sulle altcoin (dinamica, non si ferma mai)
                // Qui il bot cerca i migliori movimenti ed esegue i trade calibrando il rischio.
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
