// Vercel 서버리스 함수: Twelvedata 통합 주가 조회
// GET /api/price?symbols=005930.KS,058290.KQ,AAPL,TSLA
//
// - 국내주식: 코드.KS 또는 코드.KQ → Twelvedata KRX 시장 조회
// - 해외주식: 심볼 그대로 조회 (AAPL, TSLA, QQQ 등)
// - 무료 티어: 15분 지연 데이터, 800 콜/일, 8 콜/분

'use strict';
const https = require('https');
const { URL } = require('url');

const API_KEY = process.env.TWELVEDATA_API_KEY;

function httpsGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const parsed = new URL(url);
      const opts = {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
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

// 앱 심볼 → Twelvedata 심볼 변환
// 005930.KS / 058290.KQ → 005930:KRX (한국 전체를 KRX로)
// AAPL, TSLA 등 → 그대로
function toTd(symbol) {
  if (/^\d{6}\.(KS|KQ)$/.test(symbol)) {
    return symbol.slice(0, 6) + ':KRX';
  }
  return symbol;
}

// Twelvedata quote 결과 → 앱 형식 변환
function parseQuote(q, origSymbol) {
  if (!q || q.status === 'error' || !q.close) return null;
  const isKorean = /^\d{6}\.(KS|KQ)$/.test(origSymbol);
  const price = parseFloat(q.close);
  const prev = parseFloat(q.previous_close) || price;
  const exch = (q.exchange || '').toUpperCase();
  let exchangeDisplay = exch;
  if (isKorean) {
    exchangeDisplay = origSymbol.endsWith('.KQ') ? 'KOSDAQ' : 'KOSPI';
  }
  return {
    price,
    previousClose: prev,
    currency: q.currency || (isKorean ? 'KRW' : 'USD'),
    exchange: exchangeDisplay,
    name: q.name || '',
    symbol: origSymbol,
  };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  // 15분 캐시 (Twelvedata 무료 티어 지연과 일치)
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=120');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!API_KEY) {
    return res.status(500).json({ error: 'TWELVEDATA_API_KEY not configured in Vercel env' });
  }

  const { symbols } = req.query;
  if (!symbols) return res.status(400).json({ error: 'symbols param required (comma-separated)' });

  const origList = symbols.split(',').map(s => s.trim()).filter(Boolean);
  if (origList.length === 0) return res.status(400).json({ error: 'no valid symbols' });

  // Twelvedata는 배치 요청 지원 (쉼표 구분, 최대 120개)
  const tdList = origList.map(toTd);
  const tdParam = tdList.join(',');

  try {
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(tdParam)}&apikey=${API_KEY}`;
    const r = await httpsGet(url, 25000);

    if (r.status !== 200) {
      return res.status(r.status).json({ error: `twelvedata_upstream_${r.status}` });
    }

    let raw;
    try { raw = JSON.parse(r.body); }
    catch (e) { return res.status(502).json({ error: 'json_parse_failed', body: r.body.slice(0, 200) }); }

    // 단일 심볼이면 Twelvedata는 배열이 아닌 오브젝트 직접 반환 → 래핑
    if (origList.length === 1) {
      raw = { [tdList[0]]: raw };
    }

    const result = {};
    for (let i = 0; i < origList.length; i++) {
      const orig = origList[i];
      const td = tdList[i];
      const parsed = parseQuote(raw[td], orig);
      if (parsed) {
        result[orig] = parsed;
      } else {
        result[orig] = { error: raw[td]?.message || 'not_found', symbol: orig };
      }
    }

    return res.status(200).json(result);
  } catch (e) {
    return res.status(502).json({ error: String(e) });
  }
};
