// Vercel 서버리스 함수: 통합 주가 조회
// GET /api/price?symbols=005930.KS,058290.KQ,AAPL,TSLA
//
// 국내주식 (.KS / .KQ): Naver Finance API (서버→서버, CORS 없음)
// 해외주식 (그 외):      Twelvedata API (무료 티어, 15분 지연)

'use strict';
const https = require('https');
const { URL } = require('url');

const TWELVEDATA_KEY = process.env.TWELVEDATA_API_KEY;

const NAVER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Referer: 'https://m.stock.naver.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

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

function toNum(v) {
  if (v == null) return 0;
  return typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : Number(v);
}

// ── 국내주식: Naver Finance ──────────────────────────────────────────────────
// hintSuffix: 요청 심볼의 suffix ('KS' or 'KQ') — stockExchangeType 없을 때 폴백
async function fetchNaver(code, hintSuffix) {
  try {
    const r = await httpsGet(
      `https://m.stock.naver.com/api/stock/${code}/integration`,
      NAVER_HEADERS, 8000
    );
    if (r.status !== 200) return null;
    let d;
    try { d = JSON.parse(r.body); } catch { return null; }
    if (d.code === 'StockConflict') return null;

    // Naver API 구조 변경 대응:
    // - 구: d.closePrice / d.currentPrice / d.previousClosePrice / d.stockExchangeType
    // - 신: d.dealTrendInfos[0].closePrice / d.dealTrendInfos[0].compareToPreviousClosePrice
    const dt = d.dealTrendInfos?.[0] || {};
    const price =
      toNum(d.closePrice) || toNum(d.currentPrice) ||
      toNum(d.stockEndOfDayInfos?.[0]?.closePrice) ||
      toNum(dt.closePrice);
    if (!price || isNaN(price)) return null;

    // 전일종가 = 현재가 - 전일대비 변화값
    const change = toNum(dt.compareToPreviousClosePrice);
    const prev = toNum(d.previousClosePrice) || (price - change) || price;

    // KOSPI/KOSDAQ 판별:
    // 1순위: stockExchangeType (구 API)
    // 2순위: 요청 심볼의 suffix 힌트 (신 API에서 필드 없을 때)
    const tc = (d.stockExchangeType?.typeCode ?? '').toUpperCase();
    const sc = (d.stockExchangeType?.shortTypeCode ?? '').toUpperCase();
    const scCode = (d.stockExchangeType?.code ?? '').toUpperCase();
    let exchange;
    if (tc.includes('KOSDAQ') || sc === 'SDQ' || sc === 'KSQ' || sc === 'KOE') {
      exchange = 'KOSDAQ';
    } else if (tc.includes('KOSPI') || sc === 'STK' || scCode === 'KS') {
      exchange = 'KOSPI';
    } else {
      // API에서 판별 불가 → 요청 심볼 suffix 힌트 사용
      exchange = hintSuffix === 'KQ' ? 'KOSDAQ' : 'KOSPI';
    }

    return {
      price, previousClose: prev, currency: 'KRW',
      exchange, name: d.stockName ?? '',
      symbol: `${code}.${exchange === 'KOSPI' ? 'KS' : 'KQ'}`,
    };
  } catch { return null; }
}

// ── 해외주식: Twelvedata ─────────────────────────────────────────────────────
async function fetchTwelvedata(symbols) {
  // symbols: 원래 심볼 배열 (AAPL, TSLA, QQQ 등)
  if (!TWELVEDATA_KEY) return {};
  const tdParam = symbols.join(',');
  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(tdParam)}&apikey=${TWELVEDATA_KEY}`;
    const r = await httpsGet(url, {}, 20000);
    if (r.status !== 200) return {};
    let raw;
    try { raw = JSON.parse(r.body); } catch { return {}; }

    // 단일 심볼이면 배열이 아닌 오브젝트 직접 반환 → 래핑
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
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=120');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols param required' });

  const origList = symbols.split(',').map(s => s.trim()).filter(Boolean);
  if (origList.length === 0) return res.status(400).json({ error: 'no valid symbols' });

  // 국내 / 해외 분리
  const koreanSyms = origList.filter(s => /^\d{6}\.(KS|KQ)$/.test(s));
  const foreignSyms = origList.filter(s => !/^\d{6}\.(KS|KQ)$/.test(s));

  const result = {};

  // ① 국내주식 병렬 조회 (Naver)
  await Promise.all(koreanSyms.map(async (sym) => {
    const code = sym.slice(0, 6);
    const hintSuffix = sym.slice(7); // 'KS' or 'KQ'
    const data = await fetchNaver(code, hintSuffix);
    if (data) {
      result[sym] = { ...data, symbol: sym }; // 요청한 심볼 그대로 유지
    } else {
      result[sym] = { error: 'naver_failed', symbol: sym };
    }
  }));

  // ② 해외주식 배치 조회 (Twelvedata)
  if (foreignSyms.length > 0) {
    // Twelvedata 배치 한도 120개 → 청크 처리
    const BATCH = 120;
    for (let i = 0; i < foreignSyms.length; i += BATCH) {
      const chunk = foreignSyms.slice(i, i + BATCH);
      const td = await fetchTwelvedata(chunk);
      Object.assign(result, td);
    }
  }

  return res.status(200).json(result);
};
