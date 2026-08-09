import assert from "node:assert/strict";
import test from "node:test";

import { anthropicProvider } from "../src/llm/anthropic.js";
import { geminiProvider } from "../src/llm/gemini.js";
import { openaiProvider } from "../src/llm/openai.js";

/**
 * fetchを差し替え、送信されたボディを捕まえる。
 * 3社のツール往復は形式が大きく違うため、実際のリクエストの形を検査する。
 */
function stubFetch(responseBody) {
  const captured = {};
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    captured.url = String(url);
    captured.headers = options.headers;
    captured.body = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      json: async () => responseBody,
    };
  };
  return {
    captured,
    restore() {
      globalThis.fetch = original;
    },
  };
}

const TOOLS = [
  {
    name: "worldbank_fetch_indicator",
    description: "指標を取得する",
    parameters: {
      type: "object",
      properties: {
        indicatorId: { type: "string", description: "指標ID" },
        limit: { type: "integer", minimum: 1 },
      },
      required: ["indicatorId"],
      additionalProperties: false,
    },
  },
];

// ツールを1回使った後の履歴。この形が各社の形式へ正しく落ちるかを見る。
const HISTORY_MESSAGES = (raw) => [
  { role: "user", content: "議事録と指示" },
  {
    role: "assistant",
    content: "調べます",
    toolCalls: [
      { id: "call-1", geminiId: "g-1", name: "worldbank_fetch_indicator", input: {} },
    ],
    raw,
  },
  {
    role: "tool",
    results: [
      {
        id: "call-1",
        geminiId: "g-1",
        name: "worldbank_fetch_indicator",
        content: "GDP per capita ...",
      },
    ],
  },
];

test("Anthropic: ツール結果はuserロールのtool_resultブロックになる", async () => {
  const rawBlocks = [
    { type: "text", text: "調べます" },
    { type: "tool_use", id: "call-1", name: "worldbank_fetch_indicator", input: {} },
  ];
  const stub = stubFetch({
    content: [{ type: "text", text: "結論です" }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });

  try {
    const result = await anthropicProvider.complete({
      apiKey: "sk-test",
      model: "claude-sonnet-4-6",
      system: "あなたは議長です",
      messages: HISTORY_MESSAGES(rawBlocks),
      tools: TOOLS,
      maxTokens: 4000,
    });

    assert.equal(stub.captured.headers["x-api-key"], "sk-test");
    assert.equal(
      stub.captured.headers["anthropic-dangerous-direct-browser-access"],
      "true",
    );
    // systemはキャッシュ指定付きのブロック配列。
    assert.equal(stub.captured.body.system[0].cache_control.type, "ephemeral");
    // ツール定義はinput_schemaという名前。
    assert.deepEqual(
      stub.captured.body.tools[0].input_schema,
      TOOLS[0].parameters,
    );
    // assistantターンはrawをそのまま戻す（tool_use idの整合性のため）。
    assert.deepEqual(stub.captured.body.messages[1].content, rawBlocks);
    // ツール結果はuserロール。
    const toolTurn = stub.captured.body.messages[2];
    assert.equal(toolTurn.role, "user");
    assert.equal(toolTurn.content[0].type, "tool_result");
    assert.equal(toolTurn.content[0].tool_use_id, "call-1");

    assert.equal(result.text, "結論です");
    assert.deepEqual(result.usage, { input: 10, output: 5 });
  } finally {
    stub.restore();
  }
});

test("OpenAI: Responses APIへ送られ、ツール結果はfunction_call_outputになる", async () => {
  // 前ターンでモデルが返したoutput配列（推論アイテム＋関数呼び出し）。
  const rawOutput = [
    {
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "gAAAA-encrypted",
    },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call-1",
      name: "worldbank_fetch_indicator",
      arguments: "{}",
    },
  ];

  const stub = stubFetch({
    status: "completed",
    output: [
      { type: "reasoning", id: "rs_2", summary: [] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "結論です" }],
      },
      {
        type: "function_call",
        id: "fc_2",
        call_id: "call-2",
        name: "worldbank_fetch_indicator",
        arguments: '{"indicatorId":"NY.GDP.PCAP.CD"}',
      },
    ],
    usage: { input_tokens: 8, output_tokens: 3 },
  });

  try {
    const result = await openaiProvider.complete({
      apiKey: "sk-test",
      model: "gpt-5.6-sol",
      system: "あなたは議長です",
      messages: HISTORY_MESSAGES(rawOutput),
      tools: TOOLS,
    });

    // Chat Completionsではなく Responses API を叩く。
    assert.equal(stub.captured.url, "https://api.openai.com/v1/responses");
    assert.equal(stub.captured.headers.authorization, "Bearer sk-test");

    // systemはinstructionsへ。
    assert.equal(stub.captured.body.instructions, "あなたは議長です");

    // 推論モデルが拒否するパラメータは送らない。
    assert.ok(!("temperature" in stub.captured.body));
    assert.ok(!("max_tokens" in stub.captured.body));
    assert.ok(!("reasoning_effort" in stub.captured.body));
    assert.ok(!("messages" in stub.captured.body));

    // ツール定義は平坦な形。strictは無効。
    assert.equal(stub.captured.body.tools[0].type, "function");
    assert.equal(stub.captured.body.tools[0].name, "worldbank_fetch_indicator");
    assert.equal(stub.captured.body.tools[0].strict, false);
    assert.ok(!("function" in stub.captured.body.tools[0]));

    // 前ターンのoutputは順序を保ったまま戻る（推論アイテムを含む）。
    const input = stub.captured.body.input;
    assert.deepEqual(input[1], rawOutput[0]);
    assert.deepEqual(input[2], rawOutput[1]);

    // ツール結果はfunction_call_outputでcall_id対応。
    assert.deepEqual(input.at(-1), {
      type: "function_call_output",
      call_id: "call-1",
      output: "GDP per capita ...",
    });

    // 暗号化推論を持ち回る設定。
    assert.equal(stub.captured.body.store, false);
    assert.deepEqual(stub.captured.body.include, ["reasoning.encrypted_content"]);

    assert.equal(result.text, "結論です");
    // idはitem.idではなくcall_id。
    assert.equal(result.toolCalls[0].id, "call-2");
    assert.deepEqual(result.toolCalls[0].input, {
      indicatorId: "NY.GDP.PCAP.CD",
    });
    assert.deepEqual(result.usage, { input: 8, output: 3 });
  } finally {
    stub.restore();
  }
});

test("OpenAI: 壊れたarguments JSONでも落ちない", async () => {
  const stub = stubFetch({
    status: "completed",
    output: [
      {
        type: "function_call",
        call_id: "c",
        name: "worldbank_fetch_indicator",
        arguments: "{壊れた",
      },
    ],
  });

  try {
    const result = await openaiProvider.complete({
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: TOOLS,
    });
    assert.deepEqual(result.toolCalls[0].input, {});
  } finally {
    stub.restore();
  }
});

test("OpenAI: 出力上限で本文が空なら原因の分かるエラーになる", async () => {
  const stub = stubFetch({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
    output: [],
  });

  try {
    await assert.rejects(
      openaiProvider.complete({
        apiKey: "k",
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [],
      }),
      /出力が上限に達し/,
    );
  } finally {
    stub.restore();
  }
});

test("OpenAI: 暗号化推論に非対応なら、その機能を外して再送する", async () => {
  const rawOutput = [
    { type: "reasoning", id: "rs_1", summary: [] },
    {
      type: "function_call",
      id: "fc_1",
      call_id: "call-1",
      name: "worldbank_fetch_indicator",
      arguments: "{}",
    },
  ];

  const attempts = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    attempts.push(body);
    // 1回目は include を理由に拒否する。
    if (attempts.length === 1) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => null },
        text: async () =>
          JSON.stringify({
            error: {
              message:
                "Unsupported value: 'include' does not support 'reasoning.encrypted_content'",
            },
          }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "再送で成功" }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    };
  };

  try {
    const result = await openaiProvider.complete({
      apiKey: "k",
      // 他のテストへ影響しないよう、このテスト専用のモデル名を使う。
      model: "model-without-encrypted-reasoning",
      messages: HISTORY_MESSAGES(rawOutput),
      tools: TOOLS,
    });

    assert.equal(attempts.length, 2);
    // 1回目はincludeを付けて送っている。
    assert.deepEqual(attempts[0].include, ["reasoning.encrypted_content"]);
    // 2回目はincludeを外し、参照できない推論アイテムも履歴から落とす。
    assert.ok(!("include" in attempts[1]));
    assert.ok(!attempts[1].input.some((item) => item.type === "reasoning"));
    // 関数呼び出しとその結果の対応は保たれている。
    assert.ok(attempts[1].input.some((item) => item.type === "function_call"));
    assert.ok(
      attempts[1].input.some(
        (item) => item.type === "function_call_output" && item.call_id === "call-1",
      ),
    );

    assert.equal(result.text, "再送で成功");
  } finally {
    globalThis.fetch = original;
  }
});

test("OpenAI: 非対応の記録はモデルごとに独立している", async () => {
  const stub = stubFetch({
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "ok" }],
      },
    ],
  });

  try {
    // 直前のテストで別モデルが非対応と記録されても、こちらには影響しない。
    await openaiProvider.complete({
      apiKey: "k",
      model: "another-model",
      messages: [{ role: "user", content: "x" }],
      tools: [],
    });
    assert.deepEqual(stub.captured.body.include, ["reasoning.encrypted_content"]);
  } finally {
    stub.restore();
  }
});

test("Gemini: modelターンのpartsをそのまま戻し、思考署名を失わない", async () => {
  const rawParts = [
    {
      functionCall: {
        id: "g-1",
        name: "worldbank_fetch_indicator",
        args: {},
      },
      thoughtSignature: "signature-token",
    },
  ];
  const stub = stubFetch({
    candidates: [{ content: { parts: [{ text: "結論です" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 },
  });

  try {
    const result = await geminiProvider.complete({
      apiKey: "AIza-test",
      model: "gemini-3.6-flash",
      system: "あなたは議長です",
      messages: HISTORY_MESSAGES(rawParts),
      tools: TOOLS,
    });

    assert.equal(stub.captured.headers["x-goog-api-key"], "AIza-test");
    assert.match(stub.captured.url, /models\/gemini-3\.6-flash:generateContent$/);
    assert.equal(
      stub.captured.body.systemInstruction.parts[0].text,
      "あなたは議長です",
    );
    // 思考署名を含むpartsが欠けずに戻っている。
    assert.deepEqual(stub.captured.body.contents[1].parts, rawParts);
    assert.equal(stub.captured.body.contents[1].role, "model");
    // ツール結果はfunctionResponseとしてuserロールに載る。
    const toolTurn = stub.captured.body.contents[2];
    assert.equal(toolTurn.role, "user");
    assert.equal(toolTurn.parts[0].functionResponse.id, "g-1");
    assert.equal(
      toolTurn.parts[0].functionResponse.response.result,
      "GDP per capita ...",
    );
    // スキーマはOpenAPIサブセットへ変換されている。
    const schema = stub.captured.body.tools[0].functionDeclarations[0].parameters;
    assert.equal(schema.type, "OBJECT");
    assert.equal(schema.properties.indicatorId.type, "STRING");
    assert.ok(!("additionalProperties" in schema));

    assert.equal(result.text, "結論です");
  } finally {
    stub.restore();
  }
});

test("Gemini: 出力上限で本文が空なら原因の分かるエラーになる", async () => {
  const stub = stubFetch({
    candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
  });

  try {
    await assert.rejects(
      geminiProvider.complete({
        apiKey: "k",
        model: "m",
        messages: [{ role: "user", content: "x" }],
        tools: [],
      }),
      /最大出力トークン/,
    );
  } finally {
    stub.restore();
  }
});

test("Gemini: 思考パートは発言本文に混ぜない", async () => {
  const stub = stubFetch({
    candidates: [
      {
        content: {
          parts: [
            { text: "内部の思考", thought: true },
            { text: "実際の発言" },
          ],
        },
        finishReason: "STOP",
      },
    ],
  });

  try {
    const result = await geminiProvider.complete({
      apiKey: "k",
      model: "m",
      messages: [{ role: "user", content: "x" }],
      tools: [],
    });
    assert.equal(result.text, "実際の発言");
  } finally {
    stub.restore();
  }
});
