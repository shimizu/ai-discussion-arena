import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEvidenceCsv,
  buildMinutesMarkdown,
} from "../src/discussion/export.js";
import { ROLE } from "../src/discussion/roles.js";
import {
  DATASETS_KEY,
  MAX_DATASET_ROWS,
  SESSION_KEY,
  SESSION_VERSION,
  clearSession,
  loadSession,
  resetStorageAvailability,
  saveSession,
} from "../src/storage/session.js";

/**
 * localStorageを持たないNode上で動かすためのスタブ。
 * setItemの呼び出し回数を数え、書き込みを諦めたあとに再試行していないかを見る。
 */
function installStorage({ failOnSet = false } = {}) {
  const map = new Map();
  const stats = { setCalls: 0 };

  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      stats.setCalls += 1;
      if (failOnSet) throw new DOMException("quota", "QuotaExceededError");
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };

  resetStorageAvailability();
  return { map, stats, restore: () => delete globalThis.localStorage };
}

function makeEvidence(id, rows, extra = {}) {
  return {
    id,
    label: `資料 ${id}`,
    source: "World Bank",
    tool: "worldbank_fetch_indicator",
    input: { indicatorId: "NY.GDP.PCAP.CD" },
    content: "| 国 | 年 | 値 |",
    role: ROLE.POSITIVE,
    providerLabel: "GPT",
    dataset: {
      columns: ["国", "年", "値"],
      rows,
      totalRows: rows.length,
      ...extra,
    },
  };
}

function makeSession(evidence = []) {
  // engineと同じく、statements[].toolUses と evidence は同一オブジェクト参照にする。
  return {
    topic: "テストのテーマ",
    status: "completed",
    participants: [
      { role: ROLE.MC, providerId: "claude", providerLabel: "Claude", model: "claude-opus-4-6" },
      { role: ROLE.POSITIVE, providerId: "openai", providerLabel: "GPT", model: "gpt-5.6-terra" },
    ],
    statements: [
      {
        id: "s1",
        role: ROLE.POSITIVE,
        phase: "debate",
        round: 1,
        providerId: "openai",
        providerLabel: "GPT",
        model: "gpt-5.6-terra",
        text: "一人当たりGDPは伸びています。",
        toolUses: evidence,
        usage: { input: 10, output: 20 },
      },
    ],
    evidence,
    turnErrors: [],
  };
}

test("保存した討議はそのまま復元できる", () => {
  const storage = installStorage();
  try {
    const evidence = [makeEvidence("e1", [{ 国: "Japan", 年: "2022", 値: 33834.4 }])];
    const result = saveSession(makeSession(evidence));

    assert.equal(result.ok, true);
    assert.equal(result.degraded, "none");
    assert.equal(result.storedDatasets, 1);

    const restored = loadSession();
    assert.equal(restored.version, SESSION_VERSION);
    assert.equal(restored.topic, "テストのテーマ");
    assert.equal(restored.status, "completed");
    assert.equal(restored.participants.length, 2);
    assert.equal(restored.statements[0].text, "一人当たりGDPは伸びています。");
    assert.equal(restored.evidence[0].content, "| 国 | 年 | 値 |");
    assert.deepEqual(restored.evidence[0].dataset.rows, [
      { 国: "Japan", 年: "2022", 値: 33834.4 },
    ]);
  } finally {
    storage.restore();
  }
});

test("発言側のtoolUsesは3項目へ縮約され、行データが二重に保存されない", () => {
  const storage = installStorage();
  try {
    const evidence = [makeEvidence("e1", [{ 国: "Japan", 年: "2022", 値: 33834.4 }])];
    saveSession(makeSession(evidence));

    const sessionJson = storage.map.get(SESSION_KEY);
    const datasetsJson = storage.map.get(DATASETS_KEY);

    // 行データは datasets 側にだけ存在する。
    assert.ok(!sessionJson.includes("33834.4"));
    assert.ok(datasetsJson.includes("33834.4"));

    // 発言に残るのは id / source / label のみ。
    const parsed = JSON.parse(sessionJson);
    assert.deepEqual(Object.keys(parsed.statements[0].toolUses[0]).sort(), [
      "id",
      "label",
      "source",
    ]);

    // 復元後も発言から資料を辿れる。
    const restored = loadSession();
    assert.equal(restored.statements[0].toolUses[0].label, "資料 e1");
    assert.equal(restored.statements[0].toolUses[0].source, "World Bank");
  } finally {
    storage.restore();
  }
});

test("行数の多い資料は上限まで切り詰められ、元の件数が残る", () => {
  const storage = installStorage();
  try {
    const rows = Array.from({ length: 620 }, (_, index) => ({
      国: "Japan",
      年: String(2000 + index),
      値: index,
    }));
    const result = saveSession(makeSession([makeEvidence("e1", rows)]));

    assert.equal(result.degraded, "rows");

    const dataset = loadSession().evidence[0].dataset;
    assert.equal(dataset.rows.length, MAX_DATASET_ROWS);
    assert.equal(dataset.totalRows, 620);
    assert.equal(dataset.truncatedForStorage, true);
  } finally {
    storage.restore();
  }
});

test("予算を超えると古い資料の行データから落ちる", () => {
  const storage = installStorage();
  try {
    // 1資料あたり約500KB。3件で予算(1.2M文字)を超える。
    const bulkRows = () =>
      Array.from({ length: MAX_DATASET_ROWS }, (_, index) => ({
        国: "X".repeat(1000),
        年: String(index),
        値: index,
      }));

    const evidence = ["e1", "e2", "e3"].map((id) => makeEvidence(id, bulkRows()));
    const result = saveSession(makeSession(evidence));

    assert.equal(result.ok, true);
    assert.equal(result.degraded, "datasets");
    assert.equal(result.storedDatasets, 2);

    const restored = loadSession();
    // 資料そのものは3件とも残り、落ちるのは行データだけ。
    assert.equal(restored.evidence.length, 3);
    assert.equal(restored.evidence[0].dataset, null);
    assert.ok(restored.evidence[1].dataset);
    assert.ok(restored.evidence[2].dataset);
  } finally {
    storage.restore();
  }
});

test("書き込めない環境では失敗を返し、二度と書き込みを試さない", () => {
  const storage = installStorage({ failOnSet: true });
  try {
    const session = makeSession([makeEvidence("e1", [{ 国: "Japan", 年: "2022", 値: 1 }])]);

    const first = saveSession(session);
    assert.equal(first.ok, false);
    assert.equal(first.degraded, "failed");
    assert.equal(storage.stats.setCalls, 1);

    const second = saveSession(session);
    assert.equal(second.ok, false);
    assert.equal(storage.stats.setCalls, 1, "諦めた後はsetItemを呼ばない");
  } finally {
    storage.restore();
  }
});

test("バージョンが違う保存データは読み込まない", () => {
  const storage = installStorage();
  try {
    saveSession(makeSession([makeEvidence("e1", [{ 国: "Japan", 年: "2022", 値: 1 }])]));
    const parsed = JSON.parse(storage.map.get(SESSION_KEY));
    storage.map.set(SESSION_KEY, JSON.stringify({ ...parsed, version: 99 }));

    assert.equal(loadSession(), null);
  } finally {
    storage.restore();
  }
});

test("壊れたJSONは読み込まない", () => {
  const storage = installStorage();
  try {
    storage.map.set(SESSION_KEY, "{壊れている");
    assert.equal(loadSession(), null);
  } finally {
    storage.restore();
  }
});

test("未知のroleを持つ要素は復元時に取り除かれる", () => {
  const storage = installStorage();
  try {
    saveSession(makeSession([makeEvidence("e1", [{ 国: "Japan", 年: "2022", 値: 1 }])]));

    const parsed = JSON.parse(storage.map.get(SESSION_KEY));
    parsed.statements.push({ ...parsed.statements[0], id: "s2", role: "UNKNOWN" });
    parsed.participants.push({ role: "UNKNOWN", providerLabel: "?" });
    storage.map.set(SESSION_KEY, JSON.stringify(parsed));

    const restored = loadSession();
    assert.equal(restored.statements.length, 1);
    assert.equal(restored.participants.length, 2);
  } finally {
    storage.restore();
  }
});

test("行データが壊れていても本体は復元できる", () => {
  const storage = installStorage();
  try {
    saveSession(makeSession([makeEvidence("e1", [{ 国: "Japan", 年: "2022", 値: 1 }])]));
    storage.map.set(DATASETS_KEY, "{壊れている");

    const restored = loadSession();
    assert.equal(restored.statements.length, 1);
    assert.equal(restored.evidence[0].dataset, null);
  } finally {
    storage.restore();
  }
});

test("発言も資料も無い保存データは復元しない", () => {
  const storage = installStorage();
  try {
    const result = saveSession({ ...makeSession([]), statements: [] });
    assert.equal(result.ok, true);
    assert.equal(loadSession(), null);
  } finally {
    storage.restore();
  }
});

test("clearSessionは両方のキーを消す", () => {
  const storage = installStorage();
  try {
    saveSession(makeSession([makeEvidence("e1", [{ 国: "Japan", 年: "2022", 値: 1 }])]));
    assert.ok(storage.map.has(SESSION_KEY));
    assert.ok(storage.map.has(DATASETS_KEY));

    clearSession();
    assert.ok(!storage.map.has(SESSION_KEY));
    assert.ok(!storage.map.has(DATASETS_KEY));
    assert.equal(loadSession(), null);
  } finally {
    storage.restore();
  }
});

test("保存・復元を経ても議事録とCSVが書き出せる", () => {
  const storage = installStorage();
  try {
    const evidence = [makeEvidence("e1", [{ 国: "Japan", 年: "2022", 値: 33834.4 }])];
    saveSession(makeSession(evidence));

    const restored = loadSession();
    const payload = {
      topic: restored.topic,
      participants: restored.participants,
      statements: restored.statements,
      evidence: restored.evidence,
      turnErrors: restored.turnErrors,
      status: restored.status,
      exportedAt: new Date(2026, 7, 9, 12, 34),
    };

    // 縮約されたtoolUsesでも、議事録の参照行は組み立てられる。
    const markdown = buildMinutesMarkdown(payload);
    assert.match(markdown, /参照: World Bank 資料 e1/);
    assert.match(markdown, /### 資料1: 資料 e1/);

    // datasetもCSVへ落ちる。
    const csv = buildEvidenceCsv(payload);
    assert.match(csv, /# 資料1,資料 e1/);
    assert.match(csv, /国,年,値/);
    assert.match(csv, /Japan,2022,33834\.4/);
  } finally {
    storage.restore();
  }
});

test("localStorageが存在しない環境でも例外を投げない", () => {
  delete globalThis.localStorage;
  resetStorageAvailability();

  assert.equal(loadSession(), null);
  assert.doesNotThrow(() => clearSession());
  // setItemが呼べない＝書き込み失敗として扱う。
  assert.equal(saveSession(makeSession([])).ok, false);
});
