// Soglia d'ingresso leggermente più pronta per cogliere prima l'inizio del rimbalzo
const MIN_DAY_REBOUND_SCORE = 5.5;

function evaluateAltDailySetup(ohlcv5m, ohlcv1h, isDailyWinner, btcRegime) {
    if (!ohlcv5m || ohlcv5m.length < 24 || !ohlcv1h || ohlcv1h.length < 12) {
        return {
            valid: false,
            score: 0,
            dynamicTpGrossPct: Number((BASE_TP_NET_PCT + ESTIMATED_ROUNDTRIP_FEE_PCT).toFixed(2)),
            momentumFading: false,
            reason: "Dati insufficienti"
        };
    }

    const closes5m = ohlcv5m.map(c => c[4]);
    const lows5m = ohlcv5m.map(c => c[3]);
    const vols5m = ohlcv5m.map(c => c[5]);

    const currentPrice = closes5m[closes5m.length - 1];
    const prevClose = closes5m[closes5m.length - 2];
    const prevPrevClose = closes5m[closes5m.length - 3];

    const last24h1h = ohlcv1h.slice(-24);
    const dayLow = Math.min(...last24h1h.map(c => c[3]));
    const dayHigh = Math.max(...last24h1h.map(c => c[2]));
    const dayOpen = last24h1h[0][1];
    const dayChangePct = dayOpen > 0 ? ((currentPrice - dayOpen) / dayOpen) * 100 : 0;

    const range24h = dayHigh - dayLow;
    const positionInDayRange = range24h > 0 ? (currentPrice - dayLow) / range24h : 0.5;
    const reboundFromDayLowPct = dayLow > 0 ? ((currentPrice - dayLow) / dayLow) * 100 : 0;
    const upsideRoomToDayHighPct = currentPrice > 0 ? ((dayHigh - currentPrice) / currentPrice) * 100 : 0;

    // Tenuta sul minimo locale recente (ultime 15 candele 5m = 75 min) per entrare presto ma non in caduta libera
    const recentLow5m = Math.min(...lows5m.slice(-15, -1));
    const holdingAboveLocalLow = currentPrice >= recentLow5m * 1.001 && lows5m[lows5m.length - 1] >= recentLow5m * 0.997;

    const avgVol = vols5m.slice(-8, -1).reduce((a, b) => a + b, 0) / 7;
    const lastVol = vols5m[vols5m.length - 1];
    const greenCandlesLast4 = [
        closes5m[closes5m.length - 1] > closes5m[closes5m.length - 2],
        closes5m[closes5m.length - 2] > closes5m[closes5m.length - 3],
        closes5m[closes5m.length - 3] > closes5m[closes5m.length - 4],
        closes5m[closes5m.length - 4] > closes5m[closes5m.length - 5]
    ].filter(Boolean).length;

    let score = btcRegime.fibBoost || 0;
    const reasons = [];

    // 1. Spazio reale verso il massimo di giornata
    if (positionInDayRange <= 0.72 && upsideRoomToDayHighPct >= 1.2) {
        score += 2.5;
        reasons.push(`Spazio max +${upsideRoomToDayHighPct.toFixed(1)}%`);
    } else if (positionInDayRange > 0.88 || upsideRoomToDayHighPct < 0.85) {
        score -= 2.0;
        reasons.push("Troppo vicina al massimo di giornata");
    }

    // 2. Tenuta sopra il minimo locale / rimbalzo iniziale
    if (holdingAboveLocalLow) {
        score += 2.0;
        if (reboundFromDayLowPct >= 0.25) {
            score += 0.75;
            reasons.push(`Tiene minimo (+${reboundFromDayLowPct.toFixed(1)}% da min24h)`);
        } else {
            reasons.push("Base su minimo locale");
        }
    }

    // 3. Prima svolta sulle candele 5m (più reattiva sull'inizio del rimbalzo)
    const currentCandleGreen = closes5m[closes5m.length - 1] > closes5m[closes5m.length - 2];
    if (greenCandlesLast4 >= 2 || (currentCandleGreen && currentPrice >= prevClose)) {
        score += 2.0;
        reasons.push(`Avvio rimbalzo 5m (${greenCandlesLast4}/4 verdi)`);
    }

    // 4. Forza giornaliera
    if (isDailyWinner || dayChangePct > 1.0) {
        score += 1.25;
        reasons.push(`Forza giornaliera (${dayChangePct >= 0 ? '+' : ''}${dayChangePct.toFixed(1)}%)`);
    }

    // 5. Volumi in aumento rispetto alla media recente
    if (avgVol > 0 && lastVol >= avgVol * 1.05) {
        score += 1.0;
        reasons.push("Volumi in spinta");
    }

    let targetNet = BASE_TP_NET_PCT;
    if (btcRegime.allowAltBuys) {
        if (btcRegime.regime === "CAMBIO_FASE_DOPO_SCARICO") {
            targetNet += 0.45;
        }
        if (upsideRoomToDayHighPct >= 2.2) {
            targetNet += Math.min(0.95, (upsideRoomToDayHighPct - 1.5) * 0.35);
        }
        if (greenCandlesLast4 >= 3 && avgVol > 0 && lastVol >= avgVol * 1.15) {
            targetNet += 0.40;
        }
        if (isDailyWinner) {
            targetNet += 0.25;
        }
    } else {
        targetNet = Math.min(targetNet, 1.35);
    }

    if (upsideRoomToDayHighPct > 0 && upsideRoomToDayHighPct < 1.3) {
        targetNet = Math.min(targetNet, MIN_TP_NET_PCT);
    }

    targetNet = Math.max(MIN_TP_NET_PCT, Math.min(MAX_DYNAMIC_TP_NET_PCT, targetNet));
    const dynamicTpGrossPct = Number((targetNet + ESTIMATED_ROUNDTRIP_FEE_PCT).toFixed(2));

    const twoRedCandles = currentPrice < prevClose && prevClose < prevPrevClose;
    const nearDayHigh = upsideRoomToDayHighPct <= 0.85 && currentPrice < prevClose;
    const lowVolumePullback = avgVol > 0 && lastVol < avgVol * 0.75 && currentPrice < prevClose;
    const momentumFading = twoRedCandles || nearDayHigh || lowVolumePullback;

    const valid = score >= MIN_DAY_REBOUND_SCORE && holdingAboveLocalLow && upsideRoomToDayHighPct >= 1.0;
    return {
        valid,
        score,
        dynamicTpGrossPct,
        momentumFading,
        reason: reasons.join(" + ") || "Setup non maturo"
    };
}
