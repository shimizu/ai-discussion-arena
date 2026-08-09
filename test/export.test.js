import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvidenceCsv,
  buildExportBaseName,
  buildMinutesMarkdown,
} from "../src/discussion/export.js";
import { ROLE } from "../src/discussion/roles.js";

const EXPORTED_AT = new Date(2026, 7, 9, 12, 34);

const PARTICIPANTS = [
  { role: ROLE.MC, providerLabel: "Claude", model: "claude-opus-4-6" },
  { role: ROLE.POSITIVE, providerLabel: "GPT", model: "gpt-5.6-terra" },
  { role: ROLE.NEGATIVE, providerLabel: "Gemini", model: "gemini-3.6-flash" },
];

const STATEMENTS = [
  {
    id: "s1",
    role: ROLE.MC,
    phase: "opening",
    round: 0,
    providerLabel: "Claude",
    model: "claude-opus-4-6",
    text: "論点は3つあります。",
    toolUses: [],
  },
  {
    id: "s2",
    role: ROLE.POSITIVE,
    phase: "debate",
    round: 1,
    providerLabel: "GPT",
    model: "gpt-5.6-terra",
    text: "一人当たりGDPは伸びています。",
    toolUses: [{ id: "e1", source: "World Bank", label: "WBデータ取得 NY.GDP.PCAP.CD" }],
  },
];

const EVIDENCE = [
  {
    id: "e1",
    label: "WBデータ取得 NY.GDP.PCAP.CD",
    source: "World Bank",
    tool: "worldbank_fetch_indicator",
    input: { indicatorId: "NY.GDP.PCAP.CD", countries: "JPN" },
    content: "| 国 | 年 | 値 |\n| --- | --- | --- |\n| Japan | 2022 | 33,834 |",
    role: ROLE.POSITIVE,
    providerLabel: "GPT",
    dataset: {
      columns: ["国", "年", "値"],
      rows: [{ 国: "Japan", 年: "2022", 値: 33834.4 }],
      totalRows: 1,
    },
  },
];

const BASE = {
  topic: "日本は移民受け入れを拡大すべきか",
  participants: PARTICIPANTS,
  statements: STATEMENTS,
  evidence: EVIDENCE,
  status: "completed",
  exportedAt: EXPORTED_AT,
};

test("議事録には参加者・発言・参照・提出資料が並ぶ", () => {
  const markdown = buildMinutesMarkdown(BASE);

  assert.match(markdown, /^# 討議記録: 日本は移民受け入れを拡大すべきか$/m);
  assert.match(markdown, /出力日時: 2026-08-09 12:34/);
  assert.match(markdown, /- 議長: Claude（claude-opus-4-6）/);
  assert.match(markdown, /### 第0巡 議長（Claude）/);
  assert.match(markdown, /### 第1巡 肯定側（GPT）/);
  assert.match(markdown, /参照: World Bank WBデータ取得 NY\.GDP\.PCAP\.CD/);
  assert.match(markdown, /### 資料1: WBデータ取得 NY\.GDP\.PCAP\.CD/);
  assert.match(markdown, /出典: World Bank \/ 提出: 肯定側/);
});

test("完了した討議には中断の注記が出ない", () => {
  const markdown = buildMinutesMarkdown(BASE);
  assert.ok(!markdown.includes("最後まで進行していません"));
});

test("中断された討議は理由付きで注記される", () => {
  const aborted = buildMinutesMarkdown({ ...BASE, status: "interrupted" });
  assert.match(aborted, /> この討議は最後まで進行していません（中断（討議中にページが閉じられました））。/);

  const stopped = buildMinutesMarkdown({ ...BASE, status: "aborted" });
  assert.match(stopped, /利用者が停止しました/);
});

test("失敗した発言は議事録に残る", () => {
  const markdown = buildMinutesMarkdown({
    ...BASE,
    turnErrors: [
      { id: "t1", round: 2, role: ROLE.NEGATIVE, providerLabel: "Gemini", message: "認証に失敗しました" },
    ],
  });

  assert.match(markdown, /## 発言できなかった順番/);
  assert.match(markdown, /- 第2巡 否定側（Gemini）: 認証に失敗しました/);
});

test("資料が無い討議では提出資料の節を出さない", () => {
  const markdown = buildMinutesMarkdown({
    ...BASE,
    evidence: [],
    statements: [{ ...STATEMENTS[0] }],
  });
  assert.ok(!markdown.includes("## 提出資料"));
});

test("復元データのroleが壊れていても書き出しは通る", () => {
  const markdown = buildMinutesMarkdown({
    ...BASE,
    participants: [{ role: "UNKNOWN", providerLabel: "?", model: "?" }],
    statements: [{ ...STATEMENTS[0], role: "UNKNOWN" }],
    evidence: [],
  });
  assert.match(markdown, /- UNKNOWN: \?/);
});

test("書き出しの基底名はテーマと日時から作られ、記号を含まない", () => {
  const name = buildExportBaseName("日本は移民/受け入れ: 拡大?", EXPORTED_AT);
  assert.equal(name, "討議記録_日本は移民受け入れ 拡大_20260809-1234");
});

test("テーマが空でも基底名は成立する", () => {
  assert.equal(buildExportBaseName("   ", EXPORTED_AT), "討議記録_20260809-1234");
});

/* ----------------------------------------------------------------- CSV */

test("CSVは討議のメタデータに続いて資料ごとの表を並べる", () => {
  const csv = buildEvidenceCsv(BASE);
  const lines = csv.split("\r\n");

  assert.equal(lines[0], "# 討議テーマ,日本は移民受け入れを拡大すべきか");
  assert.equal(lines[1], "# 出力日時,2026-08-09 12:34");
  assert.equal(lines[2], "# 討議の状態,完了");
  assert.equal(lines[3], "# 参加者,議長: Claude / 肯定側: GPT / 否定側: Gemini");
  assert.equal(lines[4], "# 資料数,1");
  // 資料ブロックは空行で区切る。
  assert.equal(lines[5], "");
  assert.equal(lines[6], "# 資料1,WBデータ取得 NY.GDP.PCAP.CD");
  assert.equal(lines[7], "# 出典,World Bank");
  assert.equal(lines[8], "# ツール,worldbank_fetch_indicator");
  assert.equal(
    lines[9],
    '# 引数,"{""indicatorId"":""NY.GDP.PCAP.CD"",""countries"":""JPN""}"',
  );
  assert.equal(lines[10], "# 提出,肯定側・GPT");
  assert.equal(lines[11], "# 行数,1 行");
  assert.equal(lines[12], "国,年,値");
  assert.equal(lines[13], "Japan,2022,33834.4");
});

test("CSVは改行区切りがCRLFで、BOMを含まない", () => {
  const csv = buildEvidenceCsv(BASE);
  assert.ok(!csv.startsWith(String.fromCharCode(0xfeff)), "BOMの付与は書き出し側の責務");
  assert.ok(csv.includes("\r\n"));
  assert.ok(!/[^\r]\n/.test(csv), "LF単独の改行が混ざっている");
});

test("メタ行は常に2列に揃う", () => {
  const csv = buildEvidenceCsv({
    ...BASE,
    // 値にカンマや改行が入ってもメタ行の列数は変わらない。
    topic: "移民, 労働力\nそして人口",
  });

  for (const line of csv.split("\r\n")) {
    if (!line.startsWith("# ")) continue;
    // クォートされたセル内のカンマを除いて数える。
    const separators = line.replace(/"(?:[^"]|"")*"/g, "").split(",").length - 1;
    assert.equal(separators, 1, `2列になっていない: ${line}`);
  }
});

test("カンマ・引用符・改行を含むセルはクォートされる", () => {
  const csv = buildEvidenceCsv({
    ...BASE,
    evidence: [
      {
        ...EVIDENCE[0],
        dataset: {
          columns: ["名称", "備考"],
          rows: [
            { 名称: "東京, 大阪", 備考: 'いわゆる"三大都市圏"' },
            { 名称: "改行\nあり", 備考: null },
          ],
          totalRows: 2,
        },
      },
    ],
  });

  // 列名にカンマ等が無ければクォートしない。
  assert.ok(csv.includes("名称,備考"));
  // カンマを含むセルはクォート、引用符は二重化。
  assert.ok(csv.includes('"東京, 大阪","いわゆる""三大都市圏"""'));
  // セル内の改行はそのまま残し、クォートで包む。nullは空セル。
  assert.ok(csv.includes('"改行\nあり",'));
});

test("数式として解釈されうるセルは無効化される", () => {
  const csv = buildEvidenceCsv({
    ...BASE,
    evidence: [
      {
        ...EVIDENCE[0],
        dataset: {
          columns: ["式"],
          rows: [{ 式: "=1+1" }, { 式: "+A1" }, { 式: "@SUM(A1)" }],
          totalRows: 3,
        },
      },
    ],
  });

  assert.ok(csv.includes("'=1+1"));
  assert.ok(csv.includes("'+A1"));
  assert.ok(csv.includes("'@SUM(A1)"));
});

test("数値はロケール整形せずそのまま書く", () => {
  const csv = buildEvidenceCsv({
    ...BASE,
    evidence: [
      {
        ...EVIDENCE[0],
        dataset: {
          columns: ["値"],
          rows: [{ 値: 1234567.89 }, { 値: null }],
          totalRows: 2,
        },
      },
    ],
  });

  assert.ok(csv.includes("1234567.89"));
  assert.ok(!csv.includes("1,234,567"));
});

test("表にできない資料も番号を飛ばさずに記録される", () => {
  const csv = buildEvidenceCsv({
    ...BASE,
    evidence: [
      { ...EVIDENCE[0], id: "e1", dataset: null },
      { ...EVIDENCE[0], id: "e2", label: "2件目" },
    ],
  });

  assert.match(csv, /# 資料1,WBデータ取得/);
  assert.match(csv, /# 表形式データなし,本文は議事録のMarkdownを参照してください/);
  assert.match(csv, /# 資料2,2件目/);
});

test("保存で切り詰められた資料は行数と警告が出る", () => {
  const csv = buildEvidenceCsv({
    ...BASE,
    evidence: [
      {
        ...EVIDENCE[0],
        dataset: {
          columns: ["年"],
          rows: [{ 年: "2022" }],
          totalRows: 2000,
          truncatedForStorage: true,
          note: "統計表: 消費者物価指数",
        },
      },
    ],
  });

  assert.match(csv, /# 注記,統計表: 消費者物価指数/);
  assert.match(csv, /# 行数,1 行（取得時 2000 行）/);
  assert.match(csv, /# 警告,保存容量の制限により/);
});

test("資料が1件も無くてもヘッダは書き出される", () => {
  const csv = buildEvidenceCsv({ ...BASE, evidence: [] });
  const lines = csv.split("\r\n");

  assert.equal(lines.length, 5);
  assert.equal(lines[4], "# 資料数,0");
});

test("CSVと議事録の資料番号は一致する", () => {
  const evidence = [
    { ...EVIDENCE[0], id: "e1", label: "1件目" },
    { ...EVIDENCE[0], id: "e2", label: "2件目" },
  ];

  const csv = buildEvidenceCsv({ ...BASE, evidence });
  const markdown = buildMinutesMarkdown({ ...BASE, evidence });

  assert.match(csv, /# 資料2,2件目/);
  assert.match(markdown, /### 資料2: 2件目/);
});
