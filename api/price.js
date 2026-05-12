// Vercel 서버리스 함수: 통합 주가 조회 (Twelvedata)
// GET /api/price?symbols=005930.KS,058290.KQ,AAPL,TSLA
//
// 국내주식 (.KS → :KRX, .KQ → :KOSDAQ) + 해외주식 모두 Twelvedata로 통합

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

// 우리 심볼 → Twelvedata 심볼 변환
// 005930.KS → 005930:KRX   (KOSPI)
// 058290.KQ → 058290:KOSDAQ (KOSDAQ)
// AAPL      → AAPL          (해외, 그대로)
function toTdSymbol(sym) {
  if (/^\d{6}\.KS$/.test(sym)) return sym.slice(0, 6) + ':KRX';
  if (/^\d{6}\.KQ$/.test(sym)) return sym.slice(0, 6) + ':KOSDAQ';
  return sym;
}

// Twelvedata exchange명 → 내부 표기 변환
function toExchange(tdExchange) {
  const ex = (tdExchange || '').toUpperCase();
  if (ex === 'KRX' || ex === 'XKRX') return 'KOSPI';
  if (ex === 'KOSDAQ' || ex === 'XKOS') return 'KOSDAQ';
  return ex;
}

// Twelvedata 배치 조회
// origSymbols: 우리 포맷 심볼 배열 (005930.KS, AAPL 등)
async function fetchTwelvedata(origSymbols) {
  if (!TWELVEDATA_KEY || origSymbols.length === 0) return {};

  // Twelvedata 포맷으로 변환 + 역매핑 테이블 생성
  const tdToOrig = {};
  const tdSymbols = origSymbols.map(sym => {
    const td = toTdSymbol(sym);
    tdToOrig[td] = sym;
    return td;
  });

  const tdParam = tdSymbols.join(',');

  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(tdParam)}&apikey=${TWELVEDATA_KEY}`;
    const r = await httpsGet(url, { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' }, 20000);
    if (r.status !== 200) return {};
    let raw;
    try { raw = JSON.parse(r.body); } catch { return {}; }

    // 단일 심볼이면 오브젝트 직접 반환 → 래핑
    if (origSymbols.length === 1) raw = { [tdSymbols[0]]: raw };

    const result = {};
    for (const tdSym of tdSymbols) {
      const orig = tdToOrig[tdSym];
      const q = raw[tdSym];

      if (!q || q.status === 'error' || !q.close) {
        result[orig] = { error: q?.message || 'not_found', symbol: orig };
        continue;
      }

      const isKorean = /^\d{6}\.(KS|KQ)$/.test(orig);
      const exchange = toExchange(q.exchange);

      result[orig] = {
        price: parseFloat(q.close),
        previousClose: parseFloat(q.previous_close) || parseFloat(q.close),
        currency: q.currency || (isKorean ? 'KRW' : 'USD'),
        exchange,
        name: q.name || '',
        symbol: orig,
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

  if (!TWELVEDATA_KEY) {
    return res.status(500).json({ error: 'TWELVEDATA_API_KEY not configured' });
  }

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols param required' });

  const origList = symbols.split(',').map(s => s.trim()).filter(Boolean);
  if (origList.length === 0) return res.status(400).json({ error: 'no valid symbols' });

  const result = {};

  // Twelvedata 배치 한도 120개 → 청크 처리
  const BATCH = 120;
  for (let i = 0; i < origList.length; i += BATCH) {
    const chunk = origList.slice(i, i + BATCH);
    const td = await fetchTwelvedata(chunk);
    Object.assign(result, td);
  }

  return res.status(200).json(result);
};
