const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());

const PORT = process.env.PORT || 5000;
const EXCHANGE_ID = process.env.EXCHANGE_ID || 'kraken';
const API_KEY = process.env.API_KEY || '';
const API_SECRET = process.env.API_SECRET || '';

// Rotta di controllo dello stato e della connessione
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    exchange: EXCHANGE_ID,
    configured: Boolean(API_KEY && API_SECRET),
    mode: 'live-trading-safe'
  });
});

// Rotta per testare il recupero dei dati di mercato da Kraken
app.get('/api/market', async (req, res) => {
  try {
    const response = await axios.get('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
    res.json({
      success: true,
      data: response.data.result
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Cryptoguard backend running on port ${PORT}`);
});
