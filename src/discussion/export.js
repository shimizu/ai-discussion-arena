import { sanitizeFileName } from "../utils/download.js";
import { ROLE_META } from "./roles.js";

/**
 * 討議記録の書き出し。
 *
 * 議事録はMarkdown、取得データはCSVで出す。
 * どちらも「資料N」の番号は evidence の並び順をそのまま使うので、
 * 議事録の資料番号とCSVの資料番号は必ず対応する。
 */

const STATUS_LABEL = {
  idle: "未実施",
  running: "進行中",
  completed: "完了",
  aborted: "中断（利用者が停止しました）",
  interrupted: "中断（討議中にページが閉じられました）",
};

// 復元データが壊れていても書き出しだけは通るようにしておく。
function roleName(role) {
  return ROLE_META[role]?.name ?? String(role ?? "不明");
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatDateTime(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

function formatStamp(date) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(
    date.getHours(),
  )}${pad2(date.getMinutes())}`;
}

function renderRoster(participants) {
  return participants
    .map((participant) => `${roleName(participant.role)}: ${participant.providerLabel}`)
    .join(" / ");
}

/**
 * 議事録とCSVで同じ基底名を使い、.md と .csv が対になるようにする。
 */
export function buildExportBaseName(topic, date = new Date()) {
  const name = sanitizeFileName(topic);
  const stamp = formatStamp(date);
  return name ? `討議記録_${name}_${stamp}` : `討議記録_${stamp}`;
}

/* ------------------------------------------------------------------ CSV */

const CSV_NEWLINE = "\r\n";

/**
 * 表計算ソフトは `=` `+` `@` で始まるセルを数式として解釈する。
 * 討議データが式として実行されないよう、先頭にアポストロフィを付けて無効化する。
 */
const FORMULA_PREFIX = /^[=+@]/;

function escapeCell(value) {
  const text = String(value ?? "");
  const guarded = FORMULA_PREFIX.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

/**
 * セルの値をCSVへ落とす。数値はロケール整形しない
 * （`1,234` は表計算ソフトが文字列として読んでしまうため）。
 */
function formatCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function csvRow(cells) {
  return cells.map(escapeCell).join(",");
}

// メタ行は常に2列に揃えると、表計算ソフトでの見え方が安定する。
function metaRow(key, value) {
  return csvRow([`# ${key}`, formatCell(value)]);
}

function describeRowCount(dataset) {
  const stored = dataset.rows.length;
  const total = dataset.totalRows ?? stored;
  return stored < total ? `${stored} 行（取得時 ${total} 行）` : `${stored} 行`;
}

/**
 * 取得データのCSV。資料ごとにメタデータ行と表を連結した1ファイルにする。
 * BOMは付けない（付与は書き出し側の責務）。
 *
 * 資料番号は議事録Markdownと同じ evidence の並び順なので、両者を突き合わせられる。
 */
export function buildEvidenceCsv({
  topic,
  participants = [],
  evidence = [],
  status = "completed",
  exportedAt = new Date(),
}) {
  const lines = [
    metaRow("討議テーマ", String(topic ?? "").trim()),
    metaRow("出力日時", formatDateTime(exportedAt)),
    metaRow("討議の状態", STATUS_LABEL[status] ?? status),
    metaRow("参加者", renderRoster(participants)),
    metaRow("資料数", evidence.length),
  ];

  evidence.forEach((item, index) => {
    lines.push("");
    lines.push(metaRow(`資料${index + 1}`, item.label));
    lines.push(metaRow("出典", item.source));
    lines.push(metaRow("ツール", item.tool));
    lines.push(metaRow("引数", JSON.stringify(item.input ?? {})));
    lines.push(metaRow("提出", `${roleName(item.role)}・${item.providerLabel}`));

    const dataset = item.dataset;
    if (!dataset || dataset.rows.length === 0) {
      // 表にできない資料でも番号は飛ばさず、本文の在り処を示す。
      lines.push(metaRow("表形式データなし", "本文は議事録のMarkdownを参照してください"));
      return;
    }

    if (dataset.note) lines.push(metaRow("注記", dataset.note));
    lines.push(metaRow("行数", describeRowCount(dataset)));
    if (dataset.truncatedForStorage) {
      lines.push(
        metaRow("警告", "保存容量の制限により、リロード前のデータの一部だけが残っています"),
      );
    }

    lines.push(csvRow(dataset.columns));
    for (const row of dataset.rows) {
      lines.push(csvRow(dataset.columns.map((column) => formatCell(row[column]))));
    }
  });

  return lines.join(CSV_NEWLINE);
}

/* ------------------------------------------------------------- Markdown */

/**
 * 議事録のMarkdown。発言・参照した資料・失敗した発言・提出資料の原文を残す。
 */
export function buildMinutesMarkdown({
  topic,
  participants = [],
  statements = [],
  evidence = [],
  turnErrors = [],
  status = "completed",
  exportedAt = new Date(),
}) {
  const lines = [
    `# 討議記録: ${String(topic ?? "").trim()}`,
    "",
    `出力日時: ${formatDateTime(exportedAt)}`,
    "",
  ];

  if (status !== "completed") {
    lines.push(
      `> この討議は最後まで進行していません（${STATUS_LABEL[status] ?? status}）。`,
      "",
    );
  }

  lines.push(
    "## 参加者",
    ...participants.map(
      (participant) =>
        `- ${roleName(participant.role)}: ${participant.providerLabel}（${participant.model}）`,
    ),
    "",
    "## 議事録",
    "",
  );

  for (const statement of statements) {
    lines.push(
      `### 第${statement.round}巡 ${roleName(statement.role)}（${statement.providerLabel}）`,
      "",
      statement.text,
      "",
    );
    const toolUses = statement.toolUses ?? [];
    if (toolUses.length > 0) {
      lines.push(
        `参照: ${toolUses.map((use) => `${use.source} ${use.label}`).join(" / ")}`,
        "",
      );
    }
  }

  if (turnErrors.length > 0) {
    lines.push("## 発言できなかった順番", "");
    for (const error of turnErrors) {
      const round = error.round === undefined ? "" : `第${error.round}巡 `;
      lines.push(`- ${round}${roleName(error.role)}（${error.providerLabel}）: ${error.message}`);
    }
    lines.push("");
  }

  if (evidence.length > 0) {
    lines.push("## 提出資料", "");
    evidence.forEach((item, index) => {
      lines.push(
        `### 資料${index + 1}: ${item.label}`,
        `出典: ${item.source} / 提出: ${roleName(item.role)}`,
        "",
        "```",
        item.content,
        "```",
        "",
      );
    });
  }

  return lines.join("\n");
}
