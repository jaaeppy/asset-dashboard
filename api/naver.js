// Vercel 서버리스 함수: 네이버 종목 검색 (한글/영문 자동완성)
// GET /api/naver?type=search&q=삼성전자

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

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { type, q } = req.query;

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

  return res.status(400).json({ error: 'type=search&q=... required' });
};
