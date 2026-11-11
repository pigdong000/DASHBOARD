// 보유 주식 대시보드 - 로컬 중계 서버 (의존성 없음, Node 18+)
// - index.html 제공
// - /api/* 요청을 K Skill 프록시(k-skill-proxy)로 중계 (프록시가 CORS 헤더를 주지 않아 브라우저 직접 호출 불가)
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT || 8000);
const PROXY = (process.env.KSKILL_PROXY_BASE_URL || "https://k-skill-proxy.nomadamas.org").replace(/\/$/, "");

function kstDate(offsetDays = 0) {
  const d = new Date(Date.now() + 9 * 3600 * 1000 - offsetDays * 86400 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

async function callProxy(endpoint, params) {
  const url = `${PROXY}/v1/korean-stock/${endpoint}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => ({ error: "bad_json" }));
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// 당일 현재가: K Skill toss-investment 방식 — 토스증권 공식 Open API (본인 키 필요, 조회 전용)
// KRX(korean-stock-search)는 당일 종가를 다음 영업일 오전에야 공개하므로, 장 마감 직후
// '오늘 종가'는 토스 현재가로 채우고 전일대비는 KRX 최근 종가를 기준으로 계산한다.
// ---------------------------------------------------------------------------
const TOSS = "https://openapi.tossinvest.com";
let tossToken = null; // {value, exp}
const tossCreds = () => {
  const id = envVal("TOSSINVEST_CLIENT_ID"), secret = envVal("TOSSINVEST_CLIENT_SECRET");
  return id && secret ? { id, secret } : null;
};
async function tossPrice(code) {
  const c = tossCreds();
  if (!c) return null;
  if (!tossToken || Date.now() > tossToken.exp) {
    const r = await fetch(`${TOSS}/oauth2/token`, {
      method: "POST", redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: c.id, client_secret: c.secret }).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`토스 토큰 발급 실패: ${j.error_description || j.error || r.status}`);
    tossToken = { value: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 600) - 60) * 1000 };
  }
  const r = await fetch(`${TOSS}/api/v1/prices?symbols=${encodeURIComponent(code)}`, {
    headers: { authorization: `Bearer ${tossToken.value}`, accept: "application/json" }, redirect: "error",
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) tossToken = null;
  if (!r.ok) throw new Error(`토스 현재가 조회 실패: ${j.error?.message || r.status}`);
  const p = (j.result || [])[0];
  return p && p.lastPrice != null ? { price: Number(p.lastPrice), timestamp: p.timestamp } : null;
}

// K Skill 검색은 KOSPI/KOSDAQ/KONEX를 한 번에 조회하는데, 일부 시장 upstream이 실패하면
// 그 시장 결과가 빠진 채(degraded) 오거나 전체가 502로 끝난다.
// → 빠진 시장은 시장별로 따로 다시 조회(최대 2회)해서 합친다.
const MARKETS = ["KOSPI", "KOSDAQ", "KONEX"];
async function robustSearch(q) {
  const first = await callProxy("search", { q, limit: "20" }).catch((e) => ({ status: 502, body: { error: "relay_error", message: String(e.message || e) } }));
  const up = first.body?.upstream || {};
  const failed = first.status === 200
    ? (up.failed_markets || first.body?.failed_markets || [])
    : MARKETS;
  if (first.status === 200 && !failed.length) return [200, first.body];

  const items = first.status === 200 ? [...(first.body.items || [])] : [];
  const stillFailed = [];
  for (const market of failed) {
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      const r = await callProxy("search", { q, market, limit: "20" }).catch(() => null);
      if (r && r.status === 200 && !(r.body?.upstream?.failed_markets || []).length) {
        items.push(...(r.body.items || []));
        ok = true;
      }
    }
    if (!ok) stillFailed.push(market);
  }
  const seen = new Set();
  const merged = items.filter((it) => !seen.has(it.market + it.code) && seen.add(it.market + it.code));
  if (!merged.length && stillFailed.length === MARKETS.length) {
    return [502, { error: "upstream_error", message: first.body?.message || "K Skill 검색 실패", failed_markets: stillFailed }];
  }
  console.log(`search "${q}": 재조회 ${failed.join(",")} → 실패 ${stillFailed.join(",") || "없음"}`);
  return [200, { items: merged, failed_markets: stillFailed, query: { q } }];
}

// ---------------------------------------------------------------------------
// 뉴스: K Skill naver-news-search (k-skill-proxy /v1/naver-news/search, 키 불필요)
// ---------------------------------------------------------------------------
const cache = new Map(); // key -> {at, value}
const TTL = 5 * 60 * 1000;
async function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return { ...hit.value, cache_hit: true };
  const value = await fn();
  if (value.status === 200) cache.set(key, { at: Date.now(), value });
  return value;
}

async function newsFor(name) {
  return cached("news:" + name, async () => {
    const url = `${PROXY}/v1/naver-news/search?${new URLSearchParams({ q: name, display: "20", sort: "date" })}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    const body = await r.json().catch(() => ({ error: "bad_json" }));
    if (!r.ok) return { status: r.status, body: { error: body.error || "upstream_error", message: body.message || `HTTP ${r.status}` } };
    // 이름이 제목/요약에 실제로 들어간 기사만 남김 (검색 잡음 제거)
    const items = (body.items || [])
      .filter((it) => (it.title + " " + it.description).includes(name))
      .map((it) => ({
        title: it.title,
        summary: it.description,
        published_at: it.pub_date_iso,
        url: it.original_link || it.link,
        naver_url: it.link,
        publisher_domain: hostOf(it.original_link || it.link),
      }));
    return {
      status: 200,
      body: {
        items,
        source: {
          provider: "네이버 검색 Open API (뉴스)",
          via: "K Skill naver-news-search → k-skill-proxy /v1/naver-news/search",
          query: { q: name, sort: "date", display: 20 },
          filter: `제목·요약에 '${name}'이(가) 포함된 기사만 표시`,
          retrieved_at: new Date().toISOString(),
          total_hits: body.meta?.total ?? null,
        },
      },
    };
  });
}
function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return null; }
}

// ---------------------------------------------------------------------------
// 공시: K Skill k-dart 방식 — DART OpenAPI 직접 호출 (본인 인증키 API_K_DART 필요)
// 키는 환경변수 또는 stock-dashboard/.env 의 API_K_DART=... 로 설정
// ---------------------------------------------------------------------------
const zlib = require("zlib");
const os = require("os");
// 환경변수 → stock-dashboard/.env 순서로 값 조회
function envVal(name) {
  if (process.env[name]) return process.env[name].trim();
  try {
    const m = fs.readFileSync(path.join(__dirname, ".env"), "utf8").match(new RegExp(`^\\s*${name}\\s*=\\s*"?([^"\\r\\n]+)"?`, "m"));
    return m ? m[1].trim() : null;
  } catch { return null; }
}
const dartKey = () => envVal("API_K_DART");

// corpCode.xml(zip) → { 종목코드: {corp_code, corp_name} }  (메모리 + 임시파일 캐시, 하루 유효)
let corpMap = null;
const CORP_CACHE = path.join(os.tmpdir(), "stock-dashboard-dart-corpmap.json");
function unzipFirst(buf) {
  // EOCD → 중앙 디렉터리 첫 항목 → 로컬 헤더 → 데이터 (외부 의존성 없이 단일 파일 zip 해제)
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("zip 형식 아님");
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10), size = buf.readUInt32LE(cd + 20), lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + size);
  return method === 0 ? data : zlib.inflateRawSync(data);
}
async function loadCorpMap(key) {
  if (corpMap) return corpMap;
  try {
    const st = fs.statSync(CORP_CACHE);
    if (Date.now() - st.mtimeMs < 86400000) return (corpMap = JSON.parse(fs.readFileSync(CORP_CACHE, "utf8")));
  } catch {}
  const r = await fetch(`https://opendart.fss.or.kr/api/corpCode.xml?crtfc_key=${encodeURIComponent(key)}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.readUInt32LE(0) !== 0x04034b50) {
    // 키 오류 등은 zip 대신 JSON/XML 에러 메시지가 온다
    throw new Error("DART 고유번호 목록 다운로드 실패: " + buf.toString("utf8").slice(0, 200));
  }
  const xml = unzipFirst(buf).toString("utf8");
  const map = {};
  for (const m of xml.matchAll(/<list>([\s\S]*?)<\/list>/g)) {
    const g = (t) => (m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`)) || [])[1]?.trim() || "";
    const stock = g("stock_code");
    if (stock) map[stock] = { corp_code: g("corp_code"), corp_name: g("corp_name") };
  }
  fs.writeFileSync(CORP_CACHE, JSON.stringify(map));
  return (corpMap = map);
}

const DART_TYPES = { A: "정기공시", B: "주요사항보고", C: "발행공시", D: "지분공시", E: "기타공시", F: "외부감사관련", G: "펀드공시", H: "자산유동화", I: "거래소공시", J: "공정위공시" };
async function disclosuresFor(code, days = 90) {
  const key = dartKey();
  const dartSearchUrl = `https://dart.fss.or.kr/dsab007/main.do`; // DART 공시통합검색 (회사명으로 직접 검색)
  if (!key) {
    return {
      status: 200,
      body: {
        configured: false, items: [],
        message: "DART 인증키(API_K_DART)가 설정되지 않아 공시를 불러올 수 없습니다.",
        how_to: "https://opendart.fss.or.kr 에서 무료 인증키를 발급받아 stock-dashboard/.env 파일에 API_K_DART=발급키 한 줄을 넣고 서버를 다시 시작하세요.",
        fallback_url: dartSearchUrl,
      },
    };
  }
  return cached(`dart:${code}:${days}`, async () => {
    const map = await loadCorpMap(key);
    const corp = map[code];
    if (!corp) return { status: 200, body: { configured: true, items: [], message: `DART 고유번호 목록에서 종목코드 ${code}를 찾지 못했습니다.` } };
    const params = { crtfc_key: key, corp_code: corp.corp_code, bgn_de: kstDate(days), end_de: kstDate(0), page_count: "30", sort: "date", sort_mth: "desc" };
    const r = await fetch(`https://opendart.fss.or.kr/api/list.json?${new URLSearchParams(params)}`);
    const j = await r.json();
    if (j.status !== "000" && j.status !== "013") {
      return { status: 502, body: { configured: true, items: [], error: "dart_error", message: `DART 오류 ${j.status}: ${j.message}` } };
    }
    const items = (j.list || []).map((d) => ({
      title: d.report_nm.trim(),
      filed_on: d.rcept_dt,              // 접수일 YYYYMMDD
      filer: d.flr_nm,                   // 공시 제출인
      rcept_no: d.rcept_no,              // 접수번호 (원문 근거)
      market_note: d.rm || "",           // 비고(유: 유가증권, 코: 코스닥, 정: 정정 등)
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${d.rcept_no}`,
    }));
    return {
      status: 200,
      body: {
        configured: true, items,
        corp: { ...corp, stock_code: code },
        source: {
          provider: "금융감독원 전자공시시스템(DART) OpenAPI — 공시검색(list.json)",
          via: "K Skill k-dart 방식 (DART OpenAPI 직접 호출)",
          query: { corp_code: corp.corp_code, bgn_de: params.bgn_de, end_de: params.end_de },
          retrieved_at: new Date().toISOString(),
          total_count: j.total_count ?? items.length,
        },
      },
    };
  });
}

function send(res, status, obj) {
  // index.html을 파일(file://)로 열어도 이 서버를 호출할 수 있게 CORS 허용 (조회 전용 GET API)
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (u.pathname === "/" || u.pathname === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
    }

    // 종목 검색: /api/search?q=삼성전자
    if (u.pathname === "/api/search") {
      const q = (u.searchParams.get("q") || "").trim();
      if (!q) return send(res, 400, { error: "q 필요" });
      return send(res, ...(await robustSearch(q)));
    }

    // 일별 시세: /api/quote?market=KOSPI&code=005930
    // 휴장일·장마감 전이면 데이터가 없으므로 최근 영업일까지 최대 7일 거슬러 올라가며 재시도
    if (u.pathname === "/api/quote") {
      const market = u.searchParams.get("market") || "KOSPI";
      const code = u.searchParams.get("code") || "";
      if (!/^[0-9A-Z]{6}$/.test(code)) return send(res, 400, { error: "code 형식 오류" });
      const today = kstDate(0);
      // 1) KRX 최근 영업일 종가 (K Skill korean-stock-search)
      let krx = null, last = null;
      for (let i = 0; i < 8; i++) {
        const r = await callProxy("trade-info", { market, code, bas_dd: kstDate(i) });
        if (r.status === 200 && r.body.item) { krx = r.body.item; break; }
        last = r;
        // 인증/설정 오류는 날짜를 바꿔도 같으므로 바로 중단
        if (r.status === 503 || r.body?.error === "upstream_error") break;
      }
      // 2) KRX 기준일이 오늘이 아니면 토스 현재가로 오늘 가격 보완 (키가 있을 때만)
      let toss = null, tossError = null;
      if (!krx || krx.base_date !== today) {
        try { toss = await tossPrice(code); } catch (e) { tossError = String(e.message || e); }
      }
      const tossDay = toss?.timestamp ? toss.timestamp.slice(0, 10).replace(/-/g, "") : null;
      if (toss && (!krx || tossDay > krx.base_date)) {
        const prev = krx ? Number(krx.close_price) : null;
        return send(res, 200, {
          item: {
            code, market, name: krx?.name,
            close_price: toss.price,
            change_price: prev != null ? toss.price - prev : null,
            fluctuation_rate: prev ? Math.round(((toss.price - prev) / prev) * 10000) / 100 : null,
            base_date: tossDay, price_time: toss.timestamp,
            price_source: "toss",
            prev_close: prev, prev_close_date: krx?.base_date || null,
          },
          source: {
            price: "토스증권 Open API 현재가(/api/v1/prices) — K Skill toss-investment",
            prev_close: krx ? `KRX 일별 종가 ${krx.base_date} — K Skill korean-stock-search` : null,
          },
        });
      }
      if (krx) {
        return send(res, 200, {
          item: { ...krx, price_source: "krx", today, is_latest_close: krx.base_date === today },
          toss: { configured: !!tossCreds(), error: tossError },
          source: { price: `KRX 일별 종가 ${krx.base_date} — K Skill korean-stock-search` },
        });
      }
      return send(res, last?.status && last.status !== 200 ? last.status : 404, last?.body || { error: "not_found" });
    }

    // 종목 뉴스: /api/news?name=삼성전자
    if (u.pathname === "/api/news") {
      const name = (u.searchParams.get("name") || "").trim();
      if (name.length < 2) return send(res, 400, { error: "name은 2글자 이상" });
      const r = await newsFor(name);
      return send(res, r.status, r.body);
    }

    // 종목 공시: /api/disclosures?code=005930
    if (u.pathname === "/api/disclosures") {
      const code = u.searchParams.get("code") || "";
      if (!/^[0-9A-Z]{6}$/.test(code)) return send(res, 400, { error: "code 형식 오류" });
      try {
        const r = await disclosuresFor(code);
        return send(res, r.status, r.body);
      } catch (e) {
        return send(res, 502, { configured: true, items: [], error: "dart_error", message: String(e.message || e) });
      }
    }

    send(res, 404, { error: "not_found" });
  } catch (e) {
    console.error("relay_error", u.pathname, e.cause || e);
    send(res, 502, { error: "relay_error", message: String(e.message || e) });
  }
});

server.listen(PORT, () => {
  console.log(`보유 주식 대시보드: http://localhost:${PORT}  (K Skill 프록시: ${PROXY})`);
  console.log(`당일 현재가(토스증권): ${tossCreds() ? "TOSSINVEST_CLIENT_ID/SECRET 설정됨" : "키 없음 → KRX 최근 종가만 사용"}`);
  console.log(`DART 공시: ${dartKey() ? "API_K_DART 설정됨" : "API_K_DART 없음 → 공시 탭에 설정 안내 표시"}`);
});
