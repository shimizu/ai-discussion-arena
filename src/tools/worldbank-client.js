/**
 * World Bank Indicators API (v2) クライアント。
 * 認証不要で Access-Control-Allow-Origin: * を返すため、ブラウザから直接呼べる。
 * （worldbank-download-mcp-server のエンドポイント設計をブラウザ向けに移植したもの）
 *
 * v2 APIのレスポンスは常に [metadata, data] のタプルで返る点に注意。
 */

const API_BASE = "https://api.worldbank.org/v2";

// World Development Indicators。指標検索の母集団として使う。
const WDI_SOURCE_ID = 2;
const INDICATOR_PAGE_SIZE = 1000;
const INDICATOR_MAX_PAGES = 4;

async function callWorldBank(path, params = {}, { signal, timeoutMs = 30000 } = {}) {
  const url = new URL(`${API_BASE}${path}`);
  url.searchParams.set("format", "json");
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const compositeSignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;

  let response;
  try {
    response = await fetch(url, { signal: compositeSignal });
  } catch (error) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (timeoutSignal.aborted) {
      throw new Error("World Bank APIがタイムアウトしました。");
    }
    throw new Error(
      `World Bank APIへ接続できませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!response.ok) {
    throw new Error(`World Bank APIがHTTP ${response.status}を返しました。`);
  }

  const payload = await response.json();

  // エラー時は [{ message: [{ key, value }] }] の形で返る。
  if (Array.isArray(payload) && payload[0]?.message) {
    const detail = payload[0].message[0];
    throw new Error(
      `World Bank APIエラー: ${detail?.value ?? detail?.key ?? "不明"}`,
    );
  }

  const [metadata, data] = Array.isArray(payload) ? payload : [null, null];
  return { metadata, data: data ?? [] };
}

// 指標一覧は約1500件と大きいので、セッション中は使い回す。
let indicatorCache = null;
let indicatorCachePromise = null;

async function loadIndicatorCatalog({ signal } = {}) {
  if (indicatorCache) return indicatorCache;
  if (indicatorCachePromise) return indicatorCachePromise;

  indicatorCachePromise = (async () => {
    const all = [];
    for (let page = 1; page <= INDICATOR_MAX_PAGES; page += 1) {
      const { metadata, data } = await callWorldBank(
        "/indicator",
        { source: WDI_SOURCE_ID, per_page: INDICATOR_PAGE_SIZE, page },
        { signal, timeoutMs: 60000 },
      );
      all.push(...data);
      if (!metadata?.pages || page >= Number(metadata.pages)) break;
    }
    indicatorCache = all;
    return all;
  })();

  try {
    return await indicatorCachePromise;
  } finally {
    indicatorCachePromise = null;
  }
}

/**
 * WDIの指標をキーワードで絞り込む。
 * v2 APIには全文検索がないため、カタログを取得してクライアント側で照合する。
 */
export async function searchIndicators(input, { signal } = {}) {
  const catalog = await loadIndicatorCatalog({ signal });
  const terms = String(input.keyword ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0) {
    throw new Error("keywordを指定してください（英語のキーワードが有効です）。");
  }

  const scored = [];
  for (const indicator of catalog) {
    const id = String(indicator.id ?? "").toLowerCase();
    const name = String(indicator.name ?? "").toLowerCase();
    const note = String(indicator.sourceNote ?? "").toLowerCase();

    // 全語がどこかに含まれるものだけを候補にする。
    if (!terms.every((term) => id.includes(term) || name.includes(term) || note.includes(term))) {
      continue;
    }

    // 指標名に語が現れるものを優先する。説明文だけの一致は関連が薄い。
    const nameHits = terms.filter((term) => name.includes(term)).length;
    const idHits = terms.filter((term) => id.includes(term)).length;
    scored.push({ indicator, score: nameHits * 10 + idHits * 5 });
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    total: scored.length,
    indicators: scored.slice(0, input.limit ?? 15).map(({ indicator }) => ({
      id: indicator.id,
      name: indicator.name,
      unit: indicator.unit || undefined,
      note: truncate(indicator.sourceNote, 220),
    })),
  };
}

/**
 * 国×指標の時系列を取得する。countriesは ISO3 コードのセミコロン区切り。
 */
export async function fetchIndicatorSeries(input, { signal } = {}) {
  const countries = String(input.countries ?? "")
    .split(/[;,\s]+/)
    .filter(Boolean)
    .join(";");

  if (!countries) {
    throw new Error("countriesを指定してください（例: JPN;USA;CHN）。");
  }
  if (!input.indicatorId) {
    throw new Error("indicatorIdを指定してください。");
  }

  const { data } = await callWorldBank(
    `/country/${encodeURIComponent(countries)}/indicator/${encodeURIComponent(
      input.indicatorId,
    )}`,
    { date: input.dateRange, per_page: 20000 },
    { signal, timeoutMs: 60000 },
  );

  const rows = (data ?? [])
    .filter((row) => row && row.value !== null && row.value !== undefined)
    .map((row) => ({
      country: row.country?.value ?? row.countryiso3code,
      iso3: row.countryiso3code,
      year: row.date,
      value: row.value,
    }));

  if (rows.length === 0) {
    throw new Error(
      `指標 ${input.indicatorId} の該当データが見つかりませんでした。国コード（ISO3）と期間を確認してください。`,
    );
  }

  return {
    indicatorId: input.indicatorId,
    indicatorName: data?.[0]?.indicator?.value ?? input.indicatorId,
    dateRange: input.dateRange,
    rows,
  };
}

function truncate(text, limit) {
  if (!text) return undefined;
  const value = String(text).replace(/\s+/g, " ").trim();
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}
