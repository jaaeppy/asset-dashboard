// Vercel 서버리스 함수: 네이버 금융 CORS 프록시
// GET /api/naver?code=058290         → 현재가 조회
// GET /api/naver?type=search&q=미래에셋 → 종목 검색
// CommonJS 형식 (package.json 없이도 Vercel에서 동작)

const NAVER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  Referer: 'https://m.stock.naver.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9',
};

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
      const r = await fetch(url, { headers: NAVER_HEADERS });
      if (!r.ok) return res.status(200).json({ items: [] });
      const raw = await r.text();
      return res.status(200).send(raw);
    } catch (e) {
      return res.status(200).json({ items: [], error: String(e) });
    }
  }

  // ── 현재가 조회 ────────────────────────────────────────
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'code param required (6 digits)' });
  }

  try {
    const r = await fetch(
      `https://m.stock.naver.com/api/stock/${code}/integration`,
      { headers: NAVER_HEADERS }
    );

    if (!r.ok) {
      return res.status(r.status).json({ error: `naver_${r.status}` });
    }

    const d = await r.json();

    // 가격 파싱 — 여러 가능한 필드 순서대로 시도
    const price =
      toNum(d.closePrice) ||
      toNum(d.currentPrice) ||
      toNum(d.stockEndOfDayInfos?.[0]?.closePrice) ||
      toNum(d.dealTrendInfos?.[0]?.closePrice);

    if (!price || isNaN(price)) {
      // raw 응답 일부를 포함해서 디버깅 가능하게
      return res.status(404).json({
        error: 'price_not_found',
        keys: Object.keys(d).slice(0, 20),
      });
    }

    const prev =
      toNum(d.previousClosePrice) ||
      toNum(d.stockEndOfDayInfos?.[0]?.previousClosePrice) ||
      price;

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
