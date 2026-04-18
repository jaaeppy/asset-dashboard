// Vercel 서버리스 함수: 네이버 금융 CORS 프록시
// GET /api/naver?code=058290      → 현재가 조회
// GET /api/naver?type=search&q=미래에셋 → 종목 검색
//
// ※ fetch 대신 Node.js 내장 https 모듈 사용 (Node 14/16/18 모두 호환)

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code, type, q } = req.query;

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

  try {
    const r = await httpsGet(
      `https://m.stock.naver.com/api/stock/${code}/integration`,
      NAVER_HEADERS,
      8000
    );

    if (r.status !== 200) {
      return res.status(r.status).json({ error: `naver_upstream_${r.status}` });
    }

    let d;
    try { d = JSON.parse(r.body); }
    catch (e) { return res.status(502).json({ error: 'json_parse_failed', raw: r.body.slice(0, 200) }); }

    // 가격 파싱 — 여러 필드 순서대로 시도
    const price =
      toNum(d.closePrice) ||
      toNum(d.currentPrice) ||
      toNum(d.stockEndOfDayInfos?.[0]?.closePrice) ||
      toNum(d.dealTrendInfos?.[0]?.closePrice);

    if (!price || isNaN(price)) {
      return res.status(404).json({
        error: 'price_not_found',
        availableKeys: Object.keys(d).slice(0, 20),
      });
    }

    const prev = toNum(d.previousClosePrice) || price;

    const tc = (d.stockExchangeType?.typeCode ?? '').toUpperCase();
    const sc = (d.stockExchangeType?.shortTypeCode ?? '').toUpperCase();
    const exchange =
      tc.includes('KOSDAQ') || sc === 'SDQ' || sc === 'KSQ' || sc === 'KOE'
        ? 'KOSDAQ'
        : 'KOSPI';

    return res.status(200).json({
      price,
      previousClose: prev,
      currency: 'KRW',
      exchange,
      name: d.stockName ?? '',
      symbol: `${code}.${exchange === 'KOSPI' ? 'KS' : 'KQ'}`,
    });
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
};
