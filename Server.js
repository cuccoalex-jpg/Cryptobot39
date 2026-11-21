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
let lastLog = "Bot avviato: Versione bilanciata 5m + TP Dinamico + Termometro BTC Severo (10€).";
let focusedHotPool = [];
let dailyWinnersSet = new Set();
let lastHotPoolUpdate = 0;
global.lastBtcLivePrice = 0;

let activePositions = {};
let priceTracker = {};
let stoppedSymbolsCooldown = {};
let btcLockedUntil = 0;
let macroLockedUntil = 0;
let lastBuyTimestamp = 0;

const stablecoinsToIgnore = ['USDC', 'EURC', 'USDT', 'DAI', 'PYUSD', 'ZEUR', 'KFEE', 'EUR', 'ZUSD'];

// Watchlist richiesta (senza ETH; Cronos -> CRO; coppie non attive su Kraken vengono scartate in automatico)
const customWatchlistSymbols = [
    'PEPE/EUR', 'SUI/EUR', 'SKI/EUR', 'SOL/EUR', 'HYPE/EUR',
    'AAVE/EUR', 'ALLO/EUR', 'WLD/EUR', 'NEAR/EUR', 'SEI/EUR',
    'LINK/EUR', 'GM/EUR', 'CRO/EUR', 'MNT/EUR', 'GRT/EUR',
    'UNI/EUR', 'ENA/EUR'
];

// Parametri Rimbalzi Brevi (5m) + TP Dinamico Graduale + Trailing Stop + 6 Candele (30 min)
const ORDER_SIZE_EUR = 10;
const TIMEFRAME_ENTRY = '5m';
const MAX_CANDLES_WINDOW = 6;                 // 6 candele su 5m = 30 minuti
const MAX_HOLD_MINUTES = 30;
const ESTIMATED_ROUNDTRIP_FEE_PCT = 0.50;     // Fee andata/ritorno + spread stimate
const MIN_TP_NET_PCT = 0.70;                  // ~1.20% lordo minimo quando lo spazio è stretto
const BASE_TP_NET_PCT = 0.85;                 // ~1.35% lordo target base
const MAX_DYNAMIC_TP_NET_PCT = 2.30;          // Fino a ~2.80% lordo su V ampia, spazio libero e BTC sano
const TRAILING_ARM_GROSS_PCT = 0.85;          // Sopra +0.85% lordo arma il trailing stop
const TRAILING_FLOOR_GROSS_PCT = 0.30;        // Protezione minima sopra le fee una volta armato
const TRAILING_PULLBACK_PCT = 0.40;           // Chiude se scende di 0.40% dal picco raggiunto
const STOP_LOSS_FAST_CUT_PCT = -1.0;          // Fast-cut / stop loss

// Filtro residui / briciole in portafoglio (ignora micro-resti tipo 0.001 o controvalore irrisorio)
const MIN_TRACKED_POSITION_EUR = 1.50;        // Sotto €1.50 viene considerato residuo / polvere
const MIN_COIN_AMOUNT_FLOOR = 0.002;          // Sotto 0.002 unità non viene trattato come posizione attiva

// Ingressi un po' meno severi, tracciamento prezzi e cooldown
const MIN_ENTRY_SCORE_5M = 6.2;               // Più permissivo rispetto a 7.2 per cogliere più rimbalzi
const MIN_UPSIDE_ROOM_GROSS_PCT = 1.05;       // Margine minimo richiesto verso resistenza/banda superiore
const BUY_COOLDOWN_MS = 8 * 60 * 1000;        // 8 minuti tra un acquisto e il successivo
const SYMBOL_STOP_COOLDOWN_MS = 25 * 60 * 1000; // 25 minuti di pausa sulla coppia appena stoppata

// Macro & Geopolitica (attivi solo durante orari di apertura mercati tradizionali lun-ven)
const MACRO_INDEX_MAX_DROP_PCT = -1.2;        // Blocca se Nasdaq o S&P 500 perdono oltre -1.2% in seduta
const OIL_SHOCK_MAX_SPIKE_PCT = 3.5;          // Blocca se Petrolio WTI sale oltre +3.5% (tensione energetica/geopolitica)
const MACRO_LOCK_DURATION_MS = 15 * 60 * 1000;

// Termometro BTC SEVERO + Livelli
const BTC_FLASH_CRASH_DROP_RATIO = 0.990;     // -1.0% tra due letture live
const BTC_MAX_DROP_1H_PERCENT = -0.5;        // Blocca se BTC scende oltre -0.5% nell'ultima ora
const BTC_MAX_DROP_3H_PERCENT = -1.0;        // Blocca se BTC scende oltre -1.0% in 3 ore
const BTC_MAX_DROP_15M_4C_PERCENT = -0.6;    // Blocca se BTC scende oltre -0.6% nelle ultime 4 candele da 15m (1h)
const BTC_LOCK_DURATION_MS = 20 * 60 * 1000;  // Mantiene il blocco almeno 20 minuti quando scatta

app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>Cryptobot39 Dashboard</title></head>
            <body style="font-family: Arial; padding: 20px; background: #111; color: #fff;">
                <h1>Cryptobot39 - Stato: ${botRunning ? 'ATTIVO & OPERATIVO' : 'FERMO'}</h1>
                <p><b>Ultima attività:</b> ${lastLog}</p>
                <p><b>Posizioni Attive (>= €${MIN_TRACKED_POSITION_EUR}):</b> ${Object.keys(activePositions).length > 0 ? Object.keys(activePositions).join(', ') : 'Nessuna'}</p>
                <p><b>Watchlist Attiva (5m):</b> ${focusedHotPool.length > 0 ? focusedHotPool.join(', ') : 'Sincronizzazione in corso...'}</p>
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

function isTraditionalMarketOpenNow() {
    try {
        const now = new Date();
        const italyParts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Rome',
            weekday
