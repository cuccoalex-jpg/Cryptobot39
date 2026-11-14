const express = require('express');
const axios = require('axios');
const ccxt = require('ccxt');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 5000;
const API_KEY = process.env.API_KEY || '';
const API_SECRET = process.env.API_SECRET || '';
const CMC_API_KEY = process.env.CMC_API_KEY || ''; // Opzionale

const exchange = new ccxt.kraken({
  apiKey: API_KEY,
  secret: API_SECRET,
  enableRateLimit: true,
});

const botState = {
  isRunning: true,
  lastScan: null,
  btcTrend: 'ANALISI IN CORSO...',
  riskMultiplier: 1.0,
  activePositions: {},
  logs: []
};

function addLog(message) {
  const timestamp = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  const entry = `[${timestamp}] ${message}`;
  console.log(entry);
  botState.logs.unshift(entry);
  if (botState.logs.length > 50) botState.logs.pop();
}

function calculateSMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calculateRSI(prices, period = 14) {
  if (prices.length <= period) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

// 1. ANALISI REGIME DI MERCATO (Trend BTC)
async function analyzeBitcoinRegime() {
  try {
    const ohlcv = await exchange.fetchOHLCV('BTC/USD', '1h', undefined, 60);
    const closes = ohlcv.map(c => c[4]);
    const currentPrice = closes[closes.length - 1];
    const sma20 = calculateSMA(closes, 20);
    const sma50 = calculateSMA(closes, 50);
    const rsi = calculateRSI(closes, 14);

    if (currentPrice > sma20 && sma20 > sma50 && rsi < 75) {
      botState.btcTrend = `RIALZISTA (BTC: $${currentPrice.toFixed(0)} | RSI: ${rsi.toFixed(1)}) - Spazio per operare`;
      botState.riskMultiplier = 1.4;
    } else if (currentPrice > sma50 && rsi < 70) {
      botState.btcTrend = `MODERATO (BTC: $${currentPrice.toFixed(0)} | RSI: ${rsi.toFixed(1)}) - Operatività Standard`;
      botState.riskMultiplier = 1.0;
    } else if (rsi >= 75) {
      botState.btcTrend = `IPERCOMPRATO (BTC: $${currentPrice.toFixed(0)} | RSI: ${rsi.toFixed(1)}) - Prudenza massima`;
      botState.riskMultiplier = 0.5;
    } else {
      botState.btcTrend = `SFAVOREVOLE / RIBASSISTA (BTC: $${currentPrice.toFixed(0)} | RSI: ${rsi.toFixed(1)}) - Stop nuovi acquisti (In USD protetti)`;
      botState.riskMultiplier = 0;
    }
  } catch (err) {
    addLog(`Errore analisi BTC: ${err.message}`);
    botState.riskMultiplier = 0;
  }
}

// 2. CONVERSIONE UNA TANTUM DA EUR A USD (Prende i tuoi 50€ di prova e li converte in USD)
async function ensureOperationalUSD(requiredUSD) {
  try {
    const balance = await exchange.fetchBalance();
    let freeUSD = balance.free['USD'] || balance.free['ZUSD'] || 0;
    const freeEUR = balance.free['EUR'] || balance.free['ZEUR'] || 0;

    if (freeUSD < requiredUSD && freeEUR > 5) {
      const eurToConvert = Math.min(freeEUR, 50);
      addLog(`Rilevati EUR (€${freeEUR.toFixed(2)}). Conversione automatica una tantum di €${eurToConvert.toFixed(2)} in USD...`);
      
      await exchange.createMarketBuyOrder('EUR/USD', eurToConvert);
      
      const updatedBalance = await exchange.fetchBalance();
      freeUSD = updatedBalance.free['USD'] || updatedBalance.free['ZUSD'] || 0;
    }
    return freeUSD;
  } catch (err) {
    addLog(`Avviso gestione valuta EUR/USD: ${err.message}`);
    const balance = await exchange.fetchBalance();
    return balance.free['USD'] || balance.free['ZUSD'] || 0;
  }
}

// 3. SCANNER VOLUMI, MIGLIORI E PEGGIORI
async function getMarketCandidates() {
  let cmcTopSymbols = [];
  if (CMC_API_KEY) {
    try {
      const cmcRes = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest', {
        headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
        params: { start: 1, limit: 40, convert: 'USD', sort: 'volume_24h' }
      });
      cmcTopSymbols = cmcRes.data.data.map(coin => coin.symbol);
    } catch (e) {}
  }

  const tickers = await exchange.fetchTickers();
  const candidates = [];

  for (const [symbol, ticker] of Object.entries(tickers)) {
    if (!symbol.endsWith('/USD') || symbol.includes('USDT') || symbol.includes('USDC')) continue;
    
    const baseCoin = symbol.split('/')[0];
    const volumeUSD = ticker.quoteVolume || 0;
    const change24h = ticker.percentage || 0;

    if (volumeUSD < 300000) continue;
    if (cmcTopSymbols.length > 0 && !cmcTopSymbols.includes(baseCoin)) continue;

    const isTopGainer = change24h >= 1.5 && change24h <= 15.0;
    const isTopLoser = change24h <= -3.0 && change24h >= -15.0;

    if (isTopGainer || isTopLoser) {
      candidates.push({
        symbol,
        price: ticker.last,
        volumeUSD,
        change24h,
        category: isTopGainer ? 'TOP_GAINER' : 'TOP_LOSER_REBOUND'
      });
    }
  }

  return candidates.sort((a, b) => b.volumeUSD - a.volumeUSD).slice(0, 10);
}

// 4. GESTIONE USCITE AL NETTO DELLE COMMISSIONI E RITORNO IN USD
async function manageOpenPositions() {
  for (const [symbol, pos] of Object.entries(botState.activePositions)) {
    try {
      const ticker = await exchange.fetchTicker(symbol);
      const currentPrice = ticker.last;
      const rawProfitPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

      const estimatedFeePct = 0.5; // Commissioni stimate Kraken round-trip
      const netProfitPct = rawProfitPct - estimatedFeePct;

      if (currentPrice > pos.highestPrice) {
        pos.highestPrice = currentPrice;
      }
      const dropFromPeakPct = ((pos.highestPrice - currentPrice) / pos.highestPrice) * 100;

      if (netProfitPct <= -3.0) {
        await exchange.createMarketSellOrder(symbol, pos.remainingAmount);
        addLog(`STOP LOSS su ${symbol} (Netto: ${netProfitPct.toFixed(2)}%). Capitale recuperato in USD.`);
        delete botState.activePositions[symbol];
        continue;
      }

      if (!pos.tp1Taken && netProfitPct >= 2.2) {
        const halfAmount = pos.remainingAmount * 0.5;
        await exchange.createMarketSellOrder(symbol, halfAmount);
        pos.remainingAmount -= halfAmount;
        pos.tp1Taken = true;
        addLog(`TAKE PROFIT PARZIALE (50%) su ${symbol} | Netto stimato: +${netProfitPct.toFixed(2)}%. Guadagno incassato in USD.`);
        continue;
      }

      if (pos.tp1Taken) {
        if (netProfitPct <= 0.2) {
          await exchange.createMarketSellOrder(symbol, pos.remainingAmount);
          addLog(`CHIUSURA RESIDUO A PAREGGIO su ${symbol}: profitto precedente protetto in USD.`);
          delete botState.activePositions[symbol];
          continue;
        }
        if (dropFromPeakPct >= 1.5) {
          await exchange.createMarketSellOrder(symbol, pos.remainingAmount);
          addLog(`TRAILING STOP su ${symbol} | Chiusura con profitto netto del ${netProfitPct.toFixed(2)}% in USD.`);
          delete botState.activePositions[symbol];
          continue;
        }
      }
    } catch (err) {
      addLog(`Errore gestione posizione ${symbol}: ${err.message}`);
    }
  }
}

// 5. CICLO OPERATIVO FULL-AUTO CON CRESCITA CAPITALE
async function runTradingCycle() {
  if (!botState.isRunning || !API_KEY || !API_SECRET) return;
  botState.lastScan = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });

  try {
    await analyzeBitcoinRegime();
    await manageOpenPositions();

    if (botState.riskMultiplier === 0) {
      addLog(`Mercato sfavorevole (${botState.btcTrend}). Il bot resta in attesa con i fondi protetti in USD.`);
      return;
    }

    const operationalUSD = await ensureOperationalUSD(15);
    if (operationalUSD < 10.5) return;

    const openCount = Object.keys(botState.activePositions).length;
    if (openCount >= 4) return;

    let targetAllocationUSD = operationalUSD * 0.25; 
    if (targetAllocationUSD < 10.5) targetAllocationUSD = 10.5;

    const candidates = await getMarketCandidates();

    for (const candidate of candidates) {
      if (botState.activePositions[candidate.symbol]) continue;

      const ohlcv = await exchange.fetchOHLCV(candidate.symbol, '1h', undefined, 30);
      const closes = ohlcv.map(c => c[4]);
      const sma10 = calculateSMA(closes, 10);
      const rsi = calculateRSI(closes, 14);

      const shouldEnterGainer = candidate.category === 'TOP_GAINER' && candidate.price > sma10 && rsi < 70;
      const shouldEnterLoser = candidate.category === 'TOP_LOSER_REBOUND' && rsi < 30 && candidate.price > closes[closes.length - 2];

      if (shouldEnterGainer || shouldEnterLoser) {
        const finalInvestUSD = Math.min(operationalUSD * 0.4, targetAllocationUSD * botState.riskMultiplier);
        if (finalInvestUSD < 10.5) continue;

        const amountToBuy = finalInvestUSD / candidate.price;
        const order = await exchange.createMarketBuyOrder(candidate.symbol, amountToBuy);

        botState.activePositions[candidate.symbol] = {
          entryPrice: candidate.price,
          highestPrice: candidate.price,
          remainingAmount: order.filled || amountToBuy,
          tp1Taken: false,
          category: candidate.category
        };

        addLog(`OPERAZIONE AUTONOMA - ACQUISTO su ${candidate.symbol} (${candidate.category}) | Investiti: $${finalInvestUSD.toFixed(2)} (Capitale USD: $${operationalUSD.toFixed(2)})`);
        break; 
      }
    }
  } catch (error) {
    addLog(`Errore nel ciclo autonomo: ${error.message}`);
  }
}

setInterval(runTradingCycle, 5 * 60 * 1000);
setTimeout(runTradingCycle, 8000);

app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot_autonomous_mode: botState.isRunning,
    configured: Boolean(API_KEY && API_SECRET),
    last_scan: botState.lastScan,
    market_status: botState.btcTrend,
    risk_level: botState.riskMultiplier,
    active_smart_positions: botState.activePositions,
    decision_logs: botState.logs
  });
});

app.get('/api/toggle', (req, res) => {
  botState.isRunning = !botState.isRunning;
  addLog(`Stato bot cambiato: ${botState.isRunning ? 'ATTIVO (Full-Auto)' : 'IN PAUSA'}`);
  res.json({ bot_active: botState.isRunning });
});

app.listen(PORT, () => {
  addLog(`Motore di trading full-autonomo avviato sulla porta ${PORT}`);
});
