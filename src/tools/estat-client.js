/**
 * e-Stat APIクライアント。
 * e-Statは Access-Control-Allow-Origin: * を返すため、ブラウザから直接fetchできる。
 * （e-Stat-Web-AI-Agent の実装を討議用途向けに整理したもの）
 */

const ESTAT_JSON_BASE = "https://api.e-stat.go.jp/rest/3.0/app/json";
const PAGE_SIZE = 100000;

export function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function unwrapResponse(payload) {
  const root = payload?.[Object.keys(payload)[0]];
  const status = root?.RESULT?.STATUS;
  if (status !== 0 && status !== "0") {
    const message = root?.RESULT?.ERROR_MSG ?? "不明なe-Stat APIエラー";
    throw new Error(`e-Stat APIエラー ${status}: ${message}`);
  }
  return root;
}

/**
 * URLSearchParamsはundefinedも文字列化してしまうため、送る値を明示的に選別する。
 */
function createEstatQuery(params, appId) {
  const query = new URLSearchParams({ appId, lang: "J" });
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  return query;
}

export function normalizeSurveyYears(value) {
  if (value === undefined || value === null || value === "") return undefined;

  const text = String(value).trim();
  if (/^\d{4}$/.test(text) || /^\d{6}$/.test(text)) return text;
  if (/^\d{6}-\d{6}$/.test(text)) return text;

  // LLMが書きやすい年範囲を、e-Statが受け付ける年月範囲へ変換する。
  const yearRange = text.match(/^(\d{4})-(\d{4})$/);
  if (yearRange) return `${yearRange[1]}01-${yearRange[2]}12`;

  throw new Error(
    "surveyYearsはyyyy、yyyymm、yyyy-yyyy、またはyyyymm-yyyymm形式で指定してください。",
  );
}

async function callEstatJson(endpoint, params, { signal, appId, timeoutMs = 30000 }) {
  if (!appId) {
    throw new Error(
      "e-StatのアプリケーションIDが未設定です。API設定から登録してください。",
    );
  }

  const url = `${ESTAT_JSON_BASE}/${endpoint}?${createEstatQuery(params, appId)}`;
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
      throw new Error("e-Stat APIがタイムアウトしました。");
    }
    throw new Error(
      `e-Stat APIへ接続できませんでした: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!response.ok) {
    throw new Error(`e-Stat APIがHTTP ${response.status}を返しました（${endpoint}）。`);
  }
  return response.json();
}

export async function searchStatsTables(input, { signal, appId } = {}) {
  const payload = await callEstatJson(
    "getStatsList",
    {
      searchWord: input.searchWord,
      statsCode: input.statsCode,
      surveyYears: normalizeSurveyYears(input.surveyYears),
      limit: input.limit ?? 20,
      explanationGetFlg: "N",
    },
    { signal, appId },
  );

  const root = unwrapResponse(payload);
  const tables = asArray(root.DATALIST_INF?.TABLE_INF).map((table) => ({
    statsDataId: table["@id"],
    title: [
      table.STAT_NAME?.["$"],
      table.TITLE?.["$"] ?? table.TITLE,
      table.TITLE_SPEC?.TABLE_NAME,
    ]
      .filter(Boolean)
      .join(" / "),
    cycle: table.CYCLE,
    surveyDate: table.SURVEY_DATE,
    updated: table.UPDATED_DATE,
    rows: table.OVERALL_TOTAL_NUMBER,
  }));

  return {
    total: root.DATALIST_INF?.RESULT_INF?.TOTAL_NUMBER ?? tables.length,
    tables,
  };
}

export async function getStatsMetadata(input, { signal, appId } = {}) {
  const payload = await callEstatJson(
    "getMetaInfo",
    { statsDataId: input.statsDataId },
    { signal, appId },
  );

  const root = unwrapResponse(payload);
  const query = input.query?.toLocaleLowerCase("ja");
  const limit = input.limitPerDimension ?? 20;

  const dimensions = asArray(root.METADATA_INF?.CLASS_INF?.CLASS_OBJ).map(
    (dimension) => {
      const allItems = asArray(dimension.CLASS);
      const matched = query
        ? allItems.filter((item) =>
            `${item["@code"]} ${item["@name"]}`
              .toLocaleLowerCase("ja")
              .includes(query),
          )
        : allItems;

      return {
        paramId: dimension["@id"],
        name: dimension["@name"],
        itemCount: allItems.length,
        matchedCount: matched.length,
        items: matched.slice(0, limit).map((item) => ({
          code: item["@code"],
          name: item["@name"],
          level: item["@level"],
          unit: item["@unit"],
        })),
      };
    },
  );

  return { statsDataId: input.statsDataId, dimensions };
}

function createClassMap(classObjects) {
  const map = {};
  for (const dimension of asArray(classObjects)) {
    map[dimension["@id"]] = Object.fromEntries(
      asArray(dimension.CLASS).map((item) => [item["@code"], item]),
    );
  }
  return map;
}

function normalizeRecord(value, classMap) {
  const record = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (key === "$") {
      record.value = rawValue === "" || rawValue === null ? null : Number(rawValue);
      continue;
    }
    if (!key.startsWith("@")) continue;

    const dimension = key.slice(1);
    record[dimension] = rawValue;
    const name = classMap[dimension]?.[rawValue]?.["@name"];
    if (name) record[`${dimension}_name`] = name;
  }
  return record;
}

export async function fetchStatsData(input, { signal, appId } = {}) {
  const maxRecords = input.maxRecords ?? 2000;
  const records = [];
  let startPosition;
  let classMap = {};
  let tableInfo;

  for (let page = 0; records.length < maxRecords; page += 1) {
    const payload = await callEstatJson(
      "getStatsData",
      {
        statsDataId: input.statsDataId,
        ...input.filters,
        startPosition,
        limit: Math.min(PAGE_SIZE, maxRecords),
        metaGetFlg: page === 0 ? "Y" : "N",
        cntGetFlg: "N",
        annotationGetFlg: "N",
        explanationGetFlg: "N",
      },
      { signal, appId },
    );

    const root = unwrapResponse(payload);
    const statisticalData = root.STATISTICAL_DATA;

    if (page === 0) {
      tableInfo = statisticalData.TABLE_INF;
      classMap = createClassMap(statisticalData.CLASS_INF?.CLASS_OBJ);
    }

    for (const value of asArray(statisticalData.DATA_INF?.VALUE)) {
      records.push(normalizeRecord(value, classMap));
      if (records.length >= maxRecords) break;
    }

    const nextKey = statisticalData.RESULT_INF?.NEXT_KEY;
    if (!nextKey || records.length >= maxRecords) break;
    startPosition = String(nextKey);
  }

  return {
    statsDataId: input.statsDataId,
    title:
      tableInfo?.TITLE_SPEC?.TABLE_NAME ??
      tableInfo?.TITLE?.["$"] ??
      tableInfo?.TITLE ??
      input.statsDataId,
    records,
    truncated: records.length >= maxRecords,
  };
}
