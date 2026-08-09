import assert from "node:assert/strict";
import test from "node:test";

import { runDiscussion } from "../src/discussion/engine.js";
import { ROLE } from "../src/discussion/roles.js";

/**
 * ネットワークを持たない偽プロバイダ。
 * complete()の呼び出し履歴を残し、討議エンジンが何を送ったかを検査できるようにする。
 */
function createFakeProvider(id, behavior = {}) {
  const calls = [];
  return {
    id,
    label: `Fake-${id}`,
    vendor: "test",
    defaultModel: `${id}-model`,
    calls,
    async complete({ system, messages, tools }) {
      calls.push({ system, messages, tools });
      const response = behavior.respond?.(calls.length, { messages, tools });
      return (
        response ?? {
          text: `${id}の発言 ${calls.length}`,
          toolCalls: [],
          raw: null,
          usage: { input: 1, output: 1 },
        }
      );
    },
  };
}

function fakeRegistry(handler = async () => "データ本文") {
  return {
    definitions: () => [
      {
        name: "estat_search_tables",
        description: "検索",
        parameters: { type: "object", properties: {} },
      },
    ],
    describeTool: (name, input) => `${name}(${input?.searchWord ?? ""})`,
    sourceOf: () => "e-Stat",
    execute: handler,
  };
}

test("討議は開会・各巡・総括の順に進む", async () => {
  const providers = {
    a: createFakeProvider("a"),
    b: createFakeProvider("b"),
    c: createFakeProvider("c"),
  };

  const result = await runDiscussion({
    topic: "テストのテーマ",
    providerIds: ["a", "b", "c"],
    apiKeys: { a: "k", b: "k", c: "k" },
    models: {},
    registry: fakeRegistry(),
    maxRounds: 3,
    mcInterval: 0,
    resolveProvider: (id) => providers[id],
  });

  assert.equal(result.status, "completed");
  // 開会1 + 3巡×2 + 総括1 = 8発言
  assert.equal(result.statements.length, 8);
  assert.equal(result.statements[0].phase, "opening");
  assert.equal(result.statements[0].role, ROLE.MC);
  assert.equal(result.statements.at(-1).phase, "closing");
  assert.equal(result.statements.at(-1).role, ROLE.MC);
});

test("ツール呼び出しの結果が資料として蓄積され、次の発言者へ共有される", async () => {
  let toolInvocations = 0;

  // 最初の呼び出しでツールを1回使い、次の呼び出しで本文を返す。
  const searcher = createFakeProvider("a", {
    respond(callIndex) {
      if (callIndex === 1) {
        return {
          text: "",
          toolCalls: [
            {
              id: "call-1",
              name: "estat_search_tables",
              input: { searchWord: "消費者物価指数" },
            },
          ],
          raw: null,
          usage: { input: 1, output: 1 },
        };
      }
      return {
        text: "取得したデータによれば……",
        toolCalls: [],
        raw: null,
        usage: { input: 1, output: 1 },
      };
    },
  });

  const plain = createFakeProvider("b");

  const registry = fakeRegistry(async () => {
    toolInvocations += 1;
    return "統計表ID 0003427113 / 消費者物価指数";
  });

  const result = await runDiscussion({
    topic: "物価",
    providerIds: ["a", "b"],
    apiKeys: { a: "k", b: "k" },
    models: {},
    registry,
    maxRounds: 2,
    mcInterval: 0,
    // aが必ず開会（議長）になるよう並びを固定する。
    rng: () => 0,
    resolveProvider: (id) => (id === "a" ? searcher : plain),
  });

  assert.equal(toolInvocations, 1);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].source, "e-Stat");
  assert.match(result.evidence[0].content, /0003427113/);

  // ツールを使った発言に資料が紐づいている。
  const withEvidence = result.statements.find((s) => s.toolUses.length > 0);
  assert.ok(withEvidence, "資料が発言に紐づいていない");

  // 後続の発言者のプロンプトに、提出済み資料が含まれている。
  const laterPrompt = plain.calls.at(-1).messages[0].content;
  assert.match(laterPrompt, /提出済みの資料/);
  assert.match(laterPrompt, /0003427113/);
});

test("ツールが失敗しても討議は継続し、モデルへエラーが返る", async () => {
  let sawError = false;

  const provider = createFakeProvider("a", {
    respond(callIndex, { messages }) {
      if (callIndex === 1) {
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "estat_search_tables", input: {} }],
          raw: null,
          usage: { input: 0, output: 0 },
        };
      }
      const toolMessage = messages.find((message) => message.role === "tool");
      if (toolMessage?.results[0].isError) sawError = true;
      return { text: "続行します", toolCalls: [], raw: null, usage: { input: 0, output: 0 } };
    },
  });

  const registry = fakeRegistry(async () => {
    throw new Error("appIdが未設定です");
  });

  const result = await runDiscussion({
    topic: "テーマ",
    providerIds: ["a"],
    apiKeys: { a: "k" },
    models: {},
    registry,
    maxRounds: 1,
    mcInterval: 0,
    resolveProvider: () => provider,
  });

  assert.equal(result.status, "completed");
  assert.ok(sawError, "ツールのエラーがモデルへ渡っていない");
  assert.ok(result.statements.length > 0);
});

test("議長が[討議終了]を出すと残りの巡を飛ばして総括へ移る", async () => {
  const provider = createFakeProvider("a", {
    respond(_index, { messages }) {
      const prompt = messages[0].content;
      // 中間整理の指示を受けたときだけ終了を宣言する。
      if (prompt.includes("ここまでの議論を議長として整理")) {
        return {
          text: "論点は出尽くしました。[討議終了]",
          toolCalls: [],
          raw: null,
          usage: { input: 0, output: 0 },
        };
      }
      return { text: "発言", toolCalls: [], raw: null, usage: { input: 0, output: 0 } };
    },
  });

  const result = await runDiscussion({
    topic: "テーマ",
    providerIds: ["a"],
    apiKeys: { a: "k" },
    models: {},
    registry: fakeRegistry(),
    maxRounds: 9,
    mcInterval: 2,
    resolveProvider: () => provider,
  });

  const phases = result.statements.map((s) => s.phase);
  assert.equal(phases.at(-1), "closing");
  // 開会1 + 2巡×2 + 中間整理1 + 総括1 = 7発言で打ち切られる。
  assert.equal(result.statements.length, 7);
  // 終了マーカーは議事録に残さない。
  assert.ok(!result.statements.some((s) => s.text.includes("[討議終了]")));
});

test("中断シグナルで討議が止まる", async () => {
  const controller = new AbortController();
  const provider = createFakeProvider("a", {
    respond(callIndex) {
      if (callIndex === 2) controller.abort();
      return { text: "発言", toolCalls: [], raw: null, usage: { input: 0, output: 0 } };
    },
  });

  const result = await runDiscussion({
    topic: "テーマ",
    providerIds: ["a"],
    apiKeys: { a: "k" },
    models: {},
    registry: fakeRegistry(),
    maxRounds: 10,
    mcInterval: 0,
    signal: controller.signal,
    resolveProvider: () => provider,
  });

  assert.equal(result.status, "aborted");
  assert.ok(result.statements.length < 22);
});

test("1人が失敗しても他の参加者の討議は続く", async () => {
  const broken = createFakeProvider("bad", {
    respond() {
      throw new Error("HTTP 401");
    },
  });
  const healthy = createFakeProvider("good");

  const errors = [];
  const result = await runDiscussion({
    topic: "テーマ",
    providerIds: ["bad", "good"],
    apiKeys: { bad: "k", good: "k" },
    models: {},
    registry: fakeRegistry(),
    maxRounds: 2,
    mcInterval: 0,
    rng: () => 0,
    resolveProvider: (id) => (id === "bad" ? broken : healthy),
    onEvent: (event) => {
      if (event.type === "turn_error") errors.push(event);
    },
  });

  assert.equal(result.status, "completed");
  assert.ok(errors.length > 0, "失敗が通知されていない");
  assert.ok(result.statements.length > 0, "健全な参加者の発言まで失われている");
});
