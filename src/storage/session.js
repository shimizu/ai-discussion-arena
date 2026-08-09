import { ROLE_META } from "../discussion/roles.js";
import { STORAGE_PREFIX } from "./local.js";

/**
 * 進行中／直近の討議をブラウザへ保存する。
 *
 * 保存は2キーに分ける。
 *   SESSION_KEY  … 発言のたびに書き換わるが小さい（発言本文・参加者・失敗記録）
 *   DATASETS_KEY … 資料取得時にしか変わらないが大きい（CSV用の行データ）
 * 分けることで、発言ごとの書き込みが行データを巻き込まずに済む。
 */

export const SESSION_KEY = `${STORAGE_PREFIX}session`;
export const DATASETS_KEY = `${STORAGE_PREFIX}datasets`;
export const SESSION_VERSION = 1;

// 1資料あたりに保存する最大行数。これを超える分はリロード後には残らない。
export const MAX_DATASET_ROWS = 500;

// 行データ全体に割く文字数の上限。localStorageの枠（多くのブラウザで5MiB）に対し、
// APIキーなど他の設定が保存できる余地を必ず残すための予算。
export const SESSION_CHAR_BUDGET = 1_200_000;

// 書き込みが不可能な環境（Safariのプライベートモード等）では、
// 毎回すべての劣化段階を試すと保存のたびに数百msブロックする。一度諦めたら以後試さない。
let storageDisabled = false;

export function resetStorageAvailability() {
  storageDisabled = false;
}

function readRaw(key) {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeRaw(key, value) {
  try {
    // オプショナルチェーンだけだと、localStorageが無い環境で
    // 「何もせず成功」になってしまう。不在は失敗として扱う。
    const store = globalThis.localStorage;
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    // 容量超過のエラー名はブラウザごとに違う（QuotaExceededError /
    // NS_ERROR_DOM_QUOTA_REACHED / Safariプライベートは全書き込み失敗）。
    // 名前で分岐せず、投げられたら失敗として扱う。
    return false;
  }
}

function removeRaw(key) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // 削除失敗は無視する。
  }
}

/**
 * statements[].toolUses と evidence は engine が作る同一のオブジェクト参照。
 * そのまま直列化すると行データが2回書き出され、容量が倍になるうえ、
 * 片方だけ切り詰めても他方に全行が残ってしまう。
 * 発言側は表示と議事録が使う3フィールドだけに縮約する。
 */
function slimStatements(statements) {
  return statements.map((statement) => ({
    id: statement.id,
    role: statement.role,
    phase: statement.phase,
    round: statement.round,
    providerId: statement.providerId,
    providerLabel: statement.providerLabel,
    model: statement.model,
    text: statement.text,
    usage: statement.usage,
    toolUses: (statement.toolUses ?? []).map((use) => ({
      id: use.id,
      source: use.source,
      label: use.label,
    })),
  }));
}

/**
 * evidence を「本文まで（軽い）」と「行データ（重い）」に割る。
 */
function splitEvidence(evidence) {
  const slimEvidence = [];
  const datasets = {};

  for (const item of evidence) {
    const { dataset, ...rest } = item;
    slimEvidence.push(rest);
    if (dataset) datasets[item.id] = dataset;
  }

  return { slimEvidence, datasets };
}

/**
 * 行データを予算内へ収める。
 * 新しい資料を優先し、各資料をMAX_DATASET_ROWS行へ切り詰めたうえで、
 * それでも予算を超えるなら古い資料の行データから落とす。
 */
function budgetDatasets(datasets, evidenceOrder, budget) {
  const kept = {};
  let used = 0;
  let trimmedRows = false;
  let droppedDatasets = false;

  // 新しい順に採用する。
  for (let index = evidenceOrder.length - 1; index >= 0; index -= 1) {
    const id = evidenceOrder[index];
    const dataset = datasets[id];
    if (!dataset) continue;

    const rows = dataset.rows ?? [];
    const totalRows = dataset.totalRows ?? rows.length;
    const stored =
      rows.length > MAX_DATASET_ROWS ? rows.slice(0, MAX_DATASET_ROWS) : rows;
    if (stored.length < rows.length) trimmedRows = true;

    const entry = {
      columns: dataset.columns ?? [],
      rows: stored,
      totalRows,
      ...(dataset.note ? { note: dataset.note } : {}),
      ...(stored.length < totalRows ? { truncatedForStorage: true } : {}),
    };

    const cost = JSON.stringify(entry).length + id.length + 4;
    if (used + cost > budget) {
      droppedDatasets = true;
      continue;
    }

    kept[id] = entry;
    used += cost;
  }

  return { kept, trimmedRows, droppedDatasets };
}

/**
 * 保存されたセッションを検証する。
 *
 * localStorage は他タブ・拡張・旧バージョンによって壊れうる。
 * App にエラーバウンダリが無く、未知の role は ROLE_META[role].name で
 * アプリ全体を落とすため、読み込み時に必ず通す。
 */
function sanitizeSession(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.version !== SESSION_VERSION) return null;

  const isValidRole = (role) => Boolean(ROLE_META[role]);
  const asArray = (value) => (Array.isArray(value) ? value : []);

  const participants = asArray(parsed.participants).filter(
    (participant) =>
      participant &&
      isValidRole(participant.role) &&
      typeof participant.providerLabel === "string",
  );

  const statements = asArray(parsed.statements)
    .filter(
      (statement) =>
        statement &&
        typeof statement.id === "string" &&
        typeof statement.text === "string" &&
        isValidRole(statement.role),
    )
    .map((statement) => ({
      ...statement,
      toolUses: asArray(statement.toolUses).filter(
        (use) => use && typeof use.id === "string" && typeof use.label === "string",
      ),
    }));

  const evidence = asArray(parsed.evidence).filter(
    (item) =>
      item &&
      typeof item.id === "string" &&
      typeof item.label === "string" &&
      typeof item.content === "string" &&
      isValidRole(item.role),
  );

  const turnErrors = asArray(parsed.turnErrors).filter(
    (error) =>
      error &&
      typeof error.id === "string" &&
      typeof error.message === "string" &&
      isValidRole(error.role),
  );

  if (statements.length === 0 && evidence.length === 0) return null;

  return {
    version: SESSION_VERSION,
    savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : null,
    topic: typeof parsed.topic === "string" ? parsed.topic : "",
    status: typeof parsed.status === "string" ? parsed.status : "completed",
    participants,
    statements,
    evidence,
    turnErrors,
  };
}

/**
 * 討議の状態を保存する。
 *
 * @returns {{ok: boolean, degraded: "none"|"rows"|"datasets"|"failed", storedDatasets: number}}
 */
export function saveSession({
  topic,
  status,
  participants = [],
  statements = [],
  evidence = [],
  turnErrors = [],
  savedAt = new Date().toISOString(),
}) {
  if (storageDisabled) {
    return { ok: false, degraded: "failed", storedDatasets: 0 };
  }

  const { slimEvidence, datasets } = splitEvidence(evidence);

  const session = {
    version: SESSION_VERSION,
    savedAt,
    topic: topic ?? "",
    status: status ?? "completed",
    participants,
    statements: slimStatements(statements),
    evidence: slimEvidence,
    turnErrors,
  };

  const sessionJson = JSON.stringify(session);

  // 本体を先に書く。行データより失われて困る情報なので優先する。
  if (!writeRaw(SESSION_KEY, sessionJson)) {
    storageDisabled = true;
    removeRaw(SESSION_KEY);
    removeRaw(DATASETS_KEY);
    return { ok: false, degraded: "failed", storedDatasets: 0 };
  }

  const budget = Math.max(0, SESSION_CHAR_BUDGET - sessionJson.length);
  const { kept, trimmedRows, droppedDatasets } = budgetDatasets(
    datasets,
    slimEvidence.map((item) => item.id),
    budget,
  );

  const storedDatasets = Object.keys(kept).length;

  if (storedDatasets === 0) {
    removeRaw(DATASETS_KEY);
    const hadDatasets = Object.keys(datasets).length > 0;
    return {
      ok: true,
      degraded: hadDatasets ? "datasets" : "none",
      storedDatasets: 0,
    };
  }

  if (!writeRaw(DATASETS_KEY, JSON.stringify(kept))) {
    // 本体は無傷のまま、行データだけ諦める。
    removeRaw(DATASETS_KEY);
    return { ok: true, degraded: "datasets", storedDatasets: 0 };
  }

  const degraded = droppedDatasets ? "datasets" : trimmedRows ? "rows" : "none";
  return { ok: true, degraded, storedDatasets };
}

/**
 * 保存された討議を復元する。
 * 行データは evidence の id で突き合わせ、欠けているものは null にする。
 * この突き合わせのおかげで、容量都合で行データが落ちても復元自体は必ず成功する。
 */
export function loadSession() {
  const raw = readRaw(SESSION_KEY);
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const session = sanitizeSession(parsed);
  if (!session) return null;

  let datasets = {};
  const rawDatasets = readRaw(DATASETS_KEY);
  if (rawDatasets) {
    try {
      const candidate = JSON.parse(rawDatasets);
      if (candidate && typeof candidate === "object") datasets = candidate;
    } catch {
      // 行データが壊れていても本体は使える。
    }
  }

  return {
    ...session,
    evidence: session.evidence.map((item) => ({
      ...item,
      dataset: datasets[item.id] ?? null,
    })),
  };
}

export function clearSession() {
  removeRaw(SESSION_KEY);
  removeRaw(DATASETS_KEY);
}
