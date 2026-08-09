import {
  fetchStatsData,
  getStatsMetadata,
  searchStatsTables,
} from "./estat-client.js";
import { fetchIndicatorSeries, searchIndicators } from "./worldbank-client.js";

// LLMへ返す本文の上限。討議は発言者が3人×複数巡なので、1回のツール結果が
// 大きすぎるとコンテキストとコストをすぐ使い切る。
export const TOOL_RESULT_CHAR_CAP = 6000;

// 表として返す最大行数。
const MAX_TABLE_ROWS = 40;

function truncate(text) {
  if (text.length <= TOOL_RESULT_CHAR_CAP) return text;
  return `${text.slice(0, TOOL_RESULT_CHAR_CAP)}\n…（結果が大きいため以降を省略しました。条件を絞って再取得してください）`;
}

function renderTable(rows, columns) {
  const header = `| ${columns.join(" | ")} |`;
  const divider = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map(
    (row) => `| ${columns.map((column) => row[column] ?? "").join(" | ")} |`,
  );
  return [header, divider, ...body].join("\n");
}

/**
 * e-Statのレコードは次元コードと名称が混在するため、討議で読める列だけに絞る。
 * *_name 列（人が読める分類名）と value / unit を残し、生コードは落とす。
 */
function summarizeEstatRecords(records) {
  if (records.length === 0) return "該当データが0件でした。";

  const nameColumns = Object.keys(records[0])
    .filter((key) => key.endsWith("_name"))
    .slice(0, 5);

  const columns = [...nameColumns, "value", "unit"].filter((column) =>
    records.some((record) => record[column] !== undefined),
  );

  const rows = records.slice(0, MAX_TABLE_ROWS).map((record) =>
    Object.fromEntries(
      columns.map((column) => [
        column,
        column === "value" && typeof record.value === "number"
          ? record.value.toLocaleString("ja-JP")
          : (record[column] ?? ""),
      ]),
    ),
  );

  const note =
    records.length > MAX_TABLE_ROWS
      ? `\n\n（全${records.length.toLocaleString("ja-JP")}件のうち先頭${MAX_TABLE_ROWS}件。全体の傾向を語る場合は条件を絞って再取得してください）`
      : `\n\n（全${records.length}件）`;

  return renderTable(rows, columns) + note;
}

/**
 * LLMが書きやすい [{key, value}] 形式のフィルタをe-Statのクエリオブジェクトへ変換する。
 * オブジェクト型のadditionalPropertiesは3社間でスキーマ互換性が低いため、配列で受ける。
 */
function toFilterObject(filters) {
  const out = {};
  for (const filter of filters ?? []) {
    if (!filter?.key) continue;
    out[filter.key] = filter.value;
  }
  return out;
}

export const TOOL_DEFINITIONS = [
  {
    name: "estat_search_tables",
    source: "e-Stat",
    description:
      "日本の政府統計ポータルe-Statから統計表をキーワードで検索する。日本国内の統計を根拠にしたいとき、最初にこれでstatsDataIdを特定する。キーワードは日本語で指定する。",
    parameters: {
      type: "object",
      properties: {
        searchWord: {
          type: "string",
          description: "検索キーワード（日本語）。例: 消費者物価指数、就業構造",
        },
        surveyYears: {
          type: "string",
          description: "調査年月。yyyy、yyyymm、yyyy-yyyy、yyyymm-yyyymm のいずれか",
        },
        limit: { type: "integer", description: "取得件数（既定20）" },
      },
      required: ["searchWord"],
    },
    async handler(input, { signal, estatAppId }) {
      const result = await searchStatsTables(input, { signal, appId: estatAppId });
      if (result.tables.length === 0) {
        return "該当する統計表がありませんでした。キーワードを変えて再検索してください。";
      }
      const rows = result.tables.map((table) => ({
        statsDataId: table.statsDataId,
        統計表: table.title,
        調査年月: table.surveyDate ?? "",
        件数: table.rows ?? "",
      }));
      return truncate(
        `該当 ${result.total} 件（先頭 ${rows.length} 件を表示）\n\n${renderTable(
          rows,
          ["statsDataId", "統計表", "調査年月", "件数"],
        )}`,
      );
    },
    label: (input) => `e-Stat統計表検索「${input.searchWord ?? ""}」`,
  },

  {
    name: "estat_get_metadata",
    source: "e-Stat",
    description:
      "指定した統計表の分類事項（cat01, area, timeなど）とコード一覧を取得する。estat_fetch_dataで絞り込む前に必ず実行し、コードを推測しないこと。",
    parameters: {
      type: "object",
      properties: {
        statsDataId: {
          type: "string",
          description: "estat_search_tablesが返した統計表ID",
        },
        query: {
          type: "string",
          description: "分類名やコードの絞り込み文字列（日本語）",
        },
      },
      required: ["statsDataId"],
    },
    async handler(input, { signal, estatAppId }) {
      const result = await getStatsMetadata(input, { signal, appId: estatAppId });
      const sections = result.dimensions.map((dimension) => {
        const items = dimension.items
          .map(
            (item) =>
              `  ${item.code}: ${item.name}${item.unit ? `（単位: ${item.unit}）` : ""}`,
          )
          .join("\n");
        return `【${dimension.paramId}】${dimension.name}（全${dimension.itemCount}項目、表示${dimension.items.length}件）\n${items}`;
      });
      return truncate(
        `統計表 ${result.statsDataId} の分類事項\n\n${sections.join("\n\n")}\n\n絞り込みには cd<事項ID>（例: cdCat01=xxx、cdTimeFrom=2020000000）を使います。`,
      );
    },
    label: (input) => `e-Statメタ情報 ${input.statsDataId ?? ""}`,
  },

  {
    name: "estat_fetch_data",
    source: "e-Stat",
    description:
      "確認済みの分類コードでe-Statの統計数値を取得する。取得件数が多いと読み切れないため、filtersで年・地域・分類を必ず絞ること。",
    parameters: {
      type: "object",
      properties: {
        statsDataId: { type: "string", description: "統計表ID" },
        filters: {
          type: "array",
          description:
            "e-Statの絞り込み条件。keyにcdCat01、cdArea、cdTimeFrom、cdTimeTo、lvCat01などを指定する。",
          items: {
            type: "object",
            properties: {
              key: { type: "string", description: "パラメータ名。例: cdCat01" },
              value: { type: "string", description: "値。カンマ区切りで複数可" },
            },
            required: ["key", "value"],
          },
        },
        maxRecords: {
          type: "integer",
          description: "取得上限件数（既定2000）",
        },
      },
      required: ["statsDataId"],
    },
    async handler(input, { signal, estatAppId }) {
      const result = await fetchStatsData(
        {
          statsDataId: input.statsDataId,
          filters: toFilterObject(input.filters),
          maxRecords: input.maxRecords ?? 2000,
        },
        { signal, appId: estatAppId },
      );
      return truncate(
        `統計表: ${result.title}（${result.statsDataId}）\n\n${summarizeEstatRecords(
          result.records,
        )}`,
      );
    },
    label: (input) => `e-Statデータ取得 ${input.statsDataId ?? ""}`,
  },

  {
    name: "worldbank_search_indicators",
    source: "World Bank",
    description:
      "世界銀行の世界開発指標(WDI)を英語キーワードで検索し、指標IDを特定する。国際比較や長期時系列の根拠が必要なときに使う。キーワードは英語で指定する（例: gdp per capita, fertility rate, CO2 emissions）。",
    parameters: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "英語の検索キーワード。空白区切りで複数語をAND条件にする",
        },
        limit: { type: "integer", description: "取得件数（既定15）" },
      },
      required: ["keyword"],
    },
    async handler(input, { signal }) {
      const result = await searchIndicators(input, { signal });
      if (result.indicators.length === 0) {
        return "該当する指標がありませんでした。より一般的な英語キーワードで再検索してください。";
      }
      const body = result.indicators
        .map(
          (indicator) =>
            `- ${indicator.id}: ${indicator.name}${
              indicator.note ? `\n  ${indicator.note}` : ""
            }`,
        )
        .join("\n");
      return truncate(`該当 ${result.total} 件（先頭 ${result.indicators.length} 件）\n\n${body}`);
    },
    label: (input) => `WB指標検索「${input.keyword ?? ""}」`,
  },

  {
    name: "worldbank_fetch_indicator",
    source: "World Bank",
    description:
      "世界銀行の指標について、指定した国・期間の時系列データを取得する。国はISO3コード（JPN, USA, CHN, DEU, KOR, GBR, FRA, IND）で指定する。世界計はWLD、OECD加盟国はOED、EUはEUU、高所得国はHIC。",
    parameters: {
      type: "object",
      properties: {
        indicatorId: {
          type: "string",
          description: "指標ID。例: NY.GDP.PCAP.CD",
        },
        countries: {
          type: "string",
          description: "ISO3コードをセミコロン区切りで指定。例: JPN;USA;CHN",
        },
        dateRange: {
          type: "string",
          description: "年の範囲。例: 2000:2023。省略すると全期間",
        },
      },
      required: ["indicatorId", "countries"],
    },
    async handler(input, { signal }) {
      const result = await fetchIndicatorSeries(input, { signal });

      // 国×年の行が多くなるので、年の降順で表示上限まで切る。
      const rows = [...result.rows]
        .sort((a, b) => Number(b.year) - Number(a.year))
        .slice(0, MAX_TABLE_ROWS)
        .map((row) => ({
          国: row.country,
          年: row.year,
          値:
            typeof row.value === "number"
              ? row.value.toLocaleString("ja-JP", { maximumFractionDigits: 3 })
              : row.value,
        }));

      const note =
        result.rows.length > MAX_TABLE_ROWS
          ? `\n\n（全${result.rows.length}件のうち直近${MAX_TABLE_ROWS}件。期間を絞ると全件見られます）`
          : `\n\n（全${result.rows.length}件）`;

      return truncate(
        `指標: ${result.indicatorName}（${result.indicatorId}）\n出典: World Bank World Development Indicators\n\n${renderTable(
          rows,
          ["国", "年", "値"],
        )}${note}`,
      );
    },
    label: (input) =>
      `WBデータ取得 ${input.indicatorId ?? ""}（${input.countries ?? ""}）`,
  },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);
