// Vercel 서버리스 함수: 네이버 금융 CORS 프록시
// GET /api/naver?code=058290         → 현재가 조회
// GET /api/naver?type=search&q=미래에셋 → 종목 검색

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Referer': 'https://m.stock.naver.com/',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8',
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { code, type, q } = req.query;

  // ── 종목 검색 ─────────────────────────────────────────
  if (type === 'search' && q) {
    try {
      const url = `https://ac.finance.naver.com/api/ac?q=${encodeURIComponent(q)}&q_enc=UTF-8&target=stock,etf`;
      const r = await fetch(url, { headers: HEADERS });
      if (!r.ok) return res.status(r.status).json({ items: [] });
      const raw = await r.text();
      return res.status(200).send(raw); // 그대로 전달
    } catch (e) {
      return res.status(502).json({ items: [], error: String(e) });
    }
  }

  // ── 현재가 조회 ───────────────────────────────────────
  if (!code || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'code param required (6 digits)' });
  }

  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, {
      headers: HEADERS,
    });

    if (!r.ok) {
      return res.status(r.status).json({ error: `naver_upstream_${r.status}` });
    }

    const d = await r.json();

    // 가격 파싱 (문자열 "16,669" 또는 숫자)
    const toNum = (v) => {
      if (v == null) return 0;
      return typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : Number(v);
    };

    const price = toNum(d.closePrice ?? d.currentPrice);
    if (!price || isNaN(price)) {
      return res.status(404).json({ error: 'price_not_found', raw: d });
    }

    const prev = toNum(d.previousClosePrice) || price;

    // 시장 구분
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
}
