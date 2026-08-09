import { getJson, postJson } from "./http.js";
import { toOpenAiParameters } from "./schema.js";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
const MODELS_URL = "https://api.openai.com/v1/models";

/*
 * OpenAIはResponses APIを使う。
 *
 * GPT-5.x系は /v1/chat/completions で「関数ツール + 推論」の組み合わせを受け付けず、
 *   reasoning_effort を 'none' にするか /v1/responses を使え
 * というエラーを返す。討議では推論を切りたくないため、Responses APIへ寄せる。
 *
 * Chat Completionsとの主な違い:
 *   - system は instructions フィールドへ渡す
 *   - ツール定義は function でネストせず平坦（{ type, name, description, parameters }）
 *   - ツール呼び出しは output 配列の function_call アイテム、結果は function_call_output
 *   - 推論アイテム(reasoning)が output に混ざる。これを次のリクエストへ戻すと
 *     ツールを跨いで推論の文脈が保たれる
 */

function headers(apiKey) {
  return { authorization: `Bearer ${apiKey}` };
}

// 推論アイテムを暗号化して持ち回せるかどうかをモデルごとに記録する。
// 対応していないモデルでは400になるため、一度失敗したらそのモデルには以降送らない。
// モデル単位にするのは、設定でモデルを切り替えたときに再挑戦できるようにするため。
const encryptedReasoningByModel = new Map();

function supportsEncryptedReasoning(model) {
  return encryptedReasoningByModel.get(model) ?? true;
}

/**
 * 中立メッセージをResponses APIのinput配列へ変換する。
 *
 * assistantターンは raw（前回レスポンスのoutput配列）をそのまま展開して戻す。
 * function_callのcall_idと推論アイテムの対応が崩れると
 * 「reasoning item without its required following item」で弾かれるため、
 * 順序を保ったまま丸ごと戻すのが最も安全。
 */
function toResponsesInput(messages, { keepReasoning }) {
  const input = [];

  for (const message of messages) {
    if (message.role === "tool") {
      for (const result of message.results) {
        input.push({
          type: "function_call_output",
          call_id: result.id,
          output: result.content,
        });
      }
      continue;
    }

    if (message.role === "assistant") {
      if (Array.isArray(message.raw)) {
        for (const item of message.raw) {
          // 暗号化された推論を持ち回せない場合、idだけの推論アイテムは参照できず
          // エラーになるので落とす。推論の文脈は失われるが討議は継続できる。
          if (item.type === "reasoning" && !keepReasoning) continue;
          input.push(item);
        }
        continue;
      }
      input.push({ role: "assistant", content: message.content ?? "" });
      continue;
    }

    input.push({ role: "user", content: message.content });
  }

  return input;
}

function parseResponse(payload) {
  const output = payload.output ?? [];

  const text = output
    .filter((item) => item.type === "message")
    .flatMap((item) => item.content ?? [])
    .filter((part) => part.type === "output_text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  const toolCalls = output
    .filter((item) => item.type === "function_call")
    .map((item) => ({
      // call_id が function_call_output と対応する。item.id とは別物。
      id: item.call_id,
      name: item.name,
      input: safeParse(item.arguments),
    }));

  if (!text && toolCalls.length === 0) {
    const reason = payload.incomplete_details?.reason;
    if (reason === "max_output_tokens") {
      throw new Error(
        "OpenAIの出力が上限に達し、本文が返りませんでした。発言の文字数指定を短くするか、上限を上げてください。",
      );
    }
    if (payload.status && payload.status !== "completed") {
      throw new Error(`OpenAIが応答を完了できませんでした（${payload.status}）。`);
    }
  }

  return {
    text,
    toolCalls,
    raw: output,
    usage: {
      input: payload.usage?.input_tokens ?? 0,
      output: payload.usage?.output_tokens ?? 0,
    },
  };
}

// チャット用途に使えないモデルを一覧から除く。
const NON_CHAT_PATTERN =
  /(embedding|whisper|tts|dall-e|moderation|audio|realtime|image|transcribe|search|sora)/i;

export const openaiProvider = {
  id: "openai",
  label: "GPT",
  vendor: "OpenAI",
  defaultModel: "gpt-5.6-terra",
  keyPlaceholder: "sk-...",
  consoleUrl: "https://platform.openai.com/api-keys",

  async listModels({ apiKey, signal }) {
    const payload = await getJson({
      url: MODELS_URL,
      headers: headers(apiKey),
      signal,
      providerLabel: "OpenAI",
    });
    return (payload.data ?? [])
      .map((model) => ({ id: model.id, label: model.id }))
      .filter((model) => !NON_CHAT_PATTERN.test(model.id))
      .sort((a, b) => a.id.localeCompare(b.id));
  },

  async complete({ apiKey, model, system, messages, tools, signal }) {
    const buildBody = (keepReasoning) => {
      const body = {
        model,
        input: toResponsesInput(messages, { keepReasoning }),
        // 会話をOpenAI側に保存させず、必要な文脈は毎回こちらから送る。
        store: false,
      };

      if (system) body.instructions = system;

      if (keepReasoning) {
        // store:false のときは推論を暗号化して受け取り、次のリクエストへ戻す。
        body.include = ["reasoning.encrypted_content"];
      }

      if (tools?.length) {
        body.tools = tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          parameters: toOpenAiParameters(tool.parameters),
          // strictは全プロパティのrequired化とadditionalProperties:falseを要求するため無効化する。
          strict: false,
        }));
      }

      // reasoning.effort や temperature は指定しない。
      // 推論モデルは既定値で動き、非推論モデルはこれらを解釈しないため。

      return body;
    };

    const send = (keepReasoning) =>
      postJson({
        url: RESPONSES_URL,
        headers: headers(apiKey),
        body: buildBody(keepReasoning),
        signal,
        providerLabel: "OpenAI",
      });

    try {
      return parseResponse(await send(supportsEncryptedReasoning(model)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 暗号化推論に対応しないモデルだった場合は、その機能を諦めて再送する。
      // 推論の文脈は失われるが、討議そのものは続けられる。
      if (
        supportsEncryptedReasoning(model) &&
        /encrypted_content|\binclude\b|reasoning/i.test(message)
      ) {
        encryptedReasoningByModel.set(model, false);
        return parseResponse(await send(false));
      }
      throw error;
    }
  },
};

function safeParse(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
