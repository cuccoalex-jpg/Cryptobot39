// 3. MONITORAGGIO PRIORITARIO PORTAFOGLIO (Con calcolo P&L Netto e Fee Kraken ~0.5%)
const totalBalances = balance.total || {};
for (const currency of Object.keys(totalBalances)) {
    if (currency === 'EUR' || currency === 'ZEUR' || currency === 'KFEE') continue;
    const totalAmount = balance.total[currency] || 0;
    if (totalAmount > 0.0001) {
        let cleanCurrency = currency.replace(/^X/, '').replace(/^Z/, '');
        if (cleanCurrency === 'XBT') cleanCurrency = 'BTC';
        const symbol = `${cleanCurrency}/EUR`;
        
        if (!exchange.markets[symbol]) continue;

        try {
            const ticker = await exchange.fetchTicker(symbol);
            const currentPrice = ticker.last;

            let entryPrice = currentPrice;
            let foundRealTrade = false;
            try {
                const trades = await exchange.fetchMyTrades(symbol, undefined, 10);
                const buyTrades = trades.filter(t => t.side === 'buy');
                if (buyTrades.length > 0) {
                    entryPrice = buyTrades[buyTrades.length - 1].price;
                    foundRealTrade = true;
                }
            } catch (e) {
                console.log(`[⚠️ Avviso Storico] Impossibile leggere i trade passati per ${symbol}:`, e.message);
            }

            // Calcolo P&L Lordo e P&L Netto reale (sottraggono ~0.5% di fee totali Kraken tra entrata e uscita)
            const grossPnlPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
            const estimatedFeePercent = 0.5; 
            const netPnlPercent = grossPnlPercent - estimatedFeePercent;

            console.log(`[Portafoglio] ${symbol} | Qty: ${totalAmount} | Ingresso: €${entryPrice.toFixed(2)} (${foundRealTrade ? 'Reale' : 'Stimato'}) | Attuale: €${currentPrice.toFixed(2)} | P&L Lordo: ${grossPnlPercent.toFixed(2)}% | **P&L Netto (fee incl.): ${netPnlPercent.toFixed(2)}%**`);

            const freeAmount = balance.free[currency] || 0;
            if (freeAmount <= 0.0001) continue;

            if (isPanicCrash) {
                if (netPnlPercent < 1.2) {
                    console.log(`[🚨 PANIC EXIT] Crollo BTC! Liquidazione su ${symbol} (Netto: ${netPnlPercent.toFixed(2)}%)...`);
                    await exchange.createMarketSellOrder(symbol, freeAmount);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    continue;
                }
            }

            // Il Take-Profit ora scatta valutando il netto reale (es. se target è 1.4%, scatterà quando il netto in tasca è >= 1.4%)
            if (netPnlPercent >= dynamicTakeProfit) {
                console.log(`[TAKE-PROFIT NETTO] Target raggiunto su ${symbol} (+${netPnlPercent.toFixed(2)}% effettivi). Vendita...`);
                await exchange.createMarketSellOrder(symbol, freeAmount);
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            } 
            // ⚡ FAST-CUT: Se il trade va in rosso netto (-0.7%), chiusura immediata
            else if (netPnlPercent <= -0.7) {
                console.log(`[⚡ FAST-CUT] Il trade non parte e va in rosso (${netPnlPercent.toFixed(2)}% netto). Chiusura immediata...`);
                await exchange.createMarketSellOrder(symbol, freeAmount);
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
            else if (netPnlPercent <= dynamicStopLoss) {
                console.log(`[STOP-LOSS] Soglia raggiunta su ${symbol} (${netPnlPercent.toFixed(2)}% netto). Chiusura...`);
                await exchange.createMarketSellOrder(symbol, freeAmount);
                await new Promise(resolve => setTimeout(resolve, 5000));
                continue;
            }
        } catch (errPort) {
            console.log(`Errore portafoglio ${symbol}:`, errPort.message);
        }
    }
}
