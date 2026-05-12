// Vercel 서버리스 함수: 통합 주가 조회
// GET /api/price?symbols=005930.KS,058290.KQ,AAPL,TSLA
//
// 국내주식 (.KS / .KQ): Yahoo Finance v8 chart API (전종목 무료)
// 해외주식 (그 외):      Twelvedata API (무료 티어)

'use strict';
const https = require('https');
const { URL } = require('url');

const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY;

function httpsGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const opts = {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: headers || { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      };
      const req = https.request(opts, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', reject);
      if (timeoutMs) req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    } catch (e) { reject(e); }
  });
}

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

// ── 국내주식: Yahoo Finance v8 chart ────────────────────────────────────────
// sym: 005930.KS 또는 058290.KQ
async function fetchYahooSingle(sym) {
  for (const host of ['query1', 'query2']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
      const r = await httpsGet(url, YAHOO_HEADERS, 8000);
      if (r.status !== 200) continue;
      let d;
      try { d = JSON.parse(r.body); } catch { continue; }

      const meta = d.chart?.result?.[0]?.meta;
      if (!meta?.regularMarketPrice) continue;

      // 전일 종가: range=1d 기준 chartPreviousClose = 전일 종가
      const price = meta.regularMarketPrice;
      const prevClose = meta.chartPreviousClose || meta.previousClose || price;

      // KOSPI / KOSDAQ 판별
      // Yahoo: exchangeName "KSC" = KOSPI, "KOE" = KOSDAQ
      const exName = (meta.exchangeName || '').toUpperCase();
      const fullEx = (meta.fullExchangeName || '').toUpperCase();
      const exchange =
        exName === 'KOE' || fullEx.includes('KOSDAQ')
          ? 'KOSDAQ'
          : 'KOSPI';

      return {
        price,
        previousClose: prevClose,
        currency: meta.currency || 'KRW',
        exchange,
        name: meta.shortName || meta.longName || '',
        symbol: sym,
      };
    } catch { /* try next host */ }
  }
  return null;
}

// ── 해외주식: Twelvedata ─────────────────────────────────────────────────────
async function fetchTwelvedata(symbols) {
  if (!TWELVEDATA_KEY || symbols.length === 0) return {};
  const tdParam = symbols.join(',');
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(tdParam)}&apikey=${TWELVEDATA_KEY}`;
    const r = await httpsGet(url, {}, 20000);
    if (r.status !== 200) return {};
    let raw;
    try { raw = JSON.parse(r.body); } catch { return {}; }

    // 단일 심볼이면 오브젝트 직접 반환 → 래핑
    if (symbols.length === 1) raw = { [symbols[0]]: raw };

    const result = {};
    for (const sym of symbols) {
      const q = raw[sym];
      if (!q || q.status === 'error' || !q.close) {
        result[sym] = { error: q?.message || 'not_found', symbol: sym };
        continue;
      }
      result[sym] = {
        price: parseFloat(q.close),
        previousClose: parseFloat(q.previous_close) || parseFloat(q.close),
        currency: q.currency || 'USD',
        exchange: (q.exchange || '').toUpperCase(),
        name: q.name || '',
        symbol: sym,
      };
    }
    return result;
  } catch { return {}; }
}

// ── 핸들러 ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols param required' });

  const origList = symbols.split(',').map(s => s.trim()).filter(Boolean);
  if (origList.length === 0) return res.status(400).json({ error: 'no valid symbols' });

  // 국내 / 해외 분리
  const koreanSyms = origList.filter(s => /^\d{6}\.(KS|KQ)$/.test(s));
  const foreignSyms = origList.filter(s => !/^\d{6}\.(KS|KQ)$/.test(s));

  const result = {};

  // ① 국내주식: Yahoo Finance 병렬 조회
  await Promise.all(koreanSyms.map(async (sym) => {
    const data = await fetchYahooSingle(sym);
    result[sym] = data
      ? { ...data, symbol: sym }
      : { error: 'yahoo_failed', symbol: sym };
  }));

  // ② 해외주식: Twelvedata 배치 조회
  if (foreignSyms.length > 0) {
    const BATCH = 120;
    for (let i = 0; i < foreignSyms.length; i += BATCH) {
      const chunk = foreignSyms.slice(i, i + BATCH);
      const td = await fetchTwelvedata(chunk);
      Object.assign(result, td);
    }
  }

  return res.status(200).json(result);
};
