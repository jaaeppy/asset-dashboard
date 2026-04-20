// Vercel 서버리스 함수: 네이버 금융 CORS 프록시
// GET /api/naver?code=058290           → 현재가 조회 (Naver 우선, StockConflict 시 Yahoo 폴백)
// GET /api/naver?code=058290&market=KQ → KOSDAQ 명시 (Yahoo 폴백 시 .KQ 우선 시도)
// GET /api/naver?type=search&q=미래에셋 → 종목 검색

'use strict';
const https = require('https');
const { URL } = require('url');

const NAVER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Referer: 'https://m.stock.naver.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  Connection: 'keep-alive',
};

const YAHOO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

// Node.js https.get wrapper → { status, body }
function httpsGet(url, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const opts = {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: headers || {},
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

function toNum(v) {
  if (v == null) return 0;
  return typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : Number(v);
}

// Yahoo Finance fallback: try code.KS then code.KQ (or market-specific first)
async function fetchYahooPrice(code, preferMarket) {
  const suffixes = preferMarket === 'KQ'
    ? ['.KQ', '.KS']
    : preferMarket === 'KS'
    ? ['.KS', '.KQ']
    : ['.KS', '.KQ'];

  for (const suffix of suffixes) {
    const sym = `${code}${suffix}`;
    for (const host of ['query1', 'query2']) {
      try {
        const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`;
        const r = await httpsGet(url, YAHOO_HEADERS, 7000);
        if (r.status !== 200) continue;
        let d;
        try { d = JSON.parse(r.body); } catch { continue; }
        const meta = d.chart?.result?.[0]?.meta;
        if (meta && meta.regularMarketPrice) {
          const exName = (meta.exchangeName || '').toUpperCase();
          const exchange =
            exName.includes('KOSDAQ') || exName === 'KOE' || suffix === '.KQ'
              ? 'KOSDAQ'
              : 'KOSPI';
          return {
            price: meta.regularMarketPrice,
            previousClose: meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice,
            currency: meta.currency || 'KRW',
            exchange,
            name: meta.shortName || meta.longName || '',
            symbol: `${code}.${exchange === 'KOSPI' ? 'KS' : 'KQ'}`,
            source: 'yahoo',
          };
        }
      } catch (e) { /* try next */ }
    }
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code, type, q, market } = req.query;

  // ── 종목 검색 ──────────────────────────────────────────
  if (type === 'search' && q) {
    try {
      const url = `https://ac.finance.naver.com/api/ac?q=${encodeURIComponent(q)}&q_enc=UTF-8&target=stock,etf`;
      const r = await httpsGet(url, NAVER_HEADERS, 6000);
      if (r.status !== 200) return res.status(200).json({ items: [] });
      return res.status(200).send(r.body);
    } catch (e) {
      return res.status(200).json({ items: [], error: String(e) });
    }
  }

  // ── 현재가 조회 ────────────────────────────────────────
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'code param required (6 digits)' });
  }

  // 1) Naver 시도
  let naverResult = null;
  let stockConflict = false;
  try {
    const r = await httpsGet(
      `https://m.stock.naver.com/api/stock/${code}/integration`,
      NAVER_HEADERS,
      8000
    );

    if (r.status === 200) {
      let d;
      try { d = JSON.parse(r.body); }
      catch (e) { /* fall through to Yahoo */ }

      if (d) {
        // Naver API 구조 변경 대응 (dealTrendInfos 우선)
        const dt = d.dealTrendInfos?.[0] || {};
        const price =
          toNum(d.closePrice) ||
          toNum(d.currentPrice) ||
          toNum(d.stockEndOfDayInfos?.[0]?.closePrice) ||
          toNum(dt.closePrice);

        if (price && !isNaN(price)) {
          const change = toNum(dt.compareToPreviousClosePrice);
          const prev = toNum(d.previousClosePrice) || (price - change) || price;

          // KOSPI/KOSDAQ 판별: stockExchangeType → market param 힌트 → 기본 KOSPI
          const tc = (d.stockExchangeType?.typeCode ?? '').toUpperCase();
          const sc = (d.stockExchangeType?.shortTypeCode ?? '').toUpperCase();
          const scCode = (d.stockExchangeType?.code ?? '').toUpperCase();
          let exchange;
          if (tc.includes('KOSDAQ') || sc === 'SDQ' || sc === 'KSQ' || sc === 'KOE') {
            exchange = 'KOSDAQ';
          } else if (tc.includes('KOSPI') || sc === 'STK' || scCode === 'KS') {
            exchange = 'KOSPI';
          } else {
            exchange = market === 'KQ' ? 'KOSDAQ' : 'KOSPI';
          }

          naverResult = {
            price,
            previousClose: prev,
            currency: 'KRW',
            exchange,
            name: d.stockName ?? '',
            symbol: `${code}.${exchange === 'KOSPI' ? 'KS' : 'KQ'}`,
            source: 'naver',
          };
        }
      }
    } else if (r.status === 409) {
      // StockConflict: 동일 코드가 복수 시장에 존재 → Yahoo 폴백 필요
      stockConflict = true;
    }
  } catch (e) { /* fall through */ }

  if (naverResult) {
    return res.status(200).json(naverResult);
  }

  // 2) Yahoo Finance 폴백 (StockConflict 또는 Naver 실패 시)
  try {
    const yahoo = await fetchYahooPrice(code, market);
    if (yahoo) {
      return res.status(200).json(yahoo);
    }
  } catch (e) { /* fall through */ }

  // 3) 모두 실패
  if (stockConflict) {
    return res.status(404).json({ error: 'price_not_found', reason: 'StockConflict_yahoo_failed', code });
  }
  return res.status(404).json({ error: 'price_not_found', code });
};
