import { getJson, postJson } from "./http.js";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=100";
const ANTHROPIC_VERSION = "2023-06-01";

function headers(apiKey) {
  return {
    "x-api-key": apiKey,
    "anthropic-version": ANTHROPIC_VERSION,
    // ブラウザから直接呼ぶ場合に必須。付けないとAnthropic側が拒否する。
    "anthropic-dangerous-direct-browser-access": "true",
  };
}

/**
 * 中立メッセージをAnthropicのmessages形式へ変換する。
 * assistantターンは、ツール呼び出しのIDを一致させる必要があるため、
 * 前回レスポンスのcontentブロック（raw）をそのまま戻す。
 */
function toAnthropicMessages(messages) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: message.results.map((result) => ({
          type: "tool_result",
          tool_use_id: result.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        })),
      };
    }

    if (message.role === "assistant") {
      return { role: "assistant", content: message.raw ?? message.content };
    }

    return { role: "user", content: message.content };
  });
}

export const anthropicProvider = {
  id: "claude",
  label: "Claude",
  vendor: "Anthropic",
  defaultModel: "claude-opus-4-6",
  keyPlaceholder: "sk-ant-...",
  consoleUrl: "https://platform.claude.com/",

  async listModels({ apiKey, signal }) {
    const payload = await getJson({
      url: MODELS_URL,
      headers: headers(apiKey),
      signal,
      providerLabel: "Anthropic",
    });
    return (payload.data ?? []).map((model) => ({
      id: model.id,
      label: model.display_name ?? model.id,
    }));
  },

  async complete({ apiKey, model, system, messages, tools, maxTokens, signal }) {
    const body = {
      model,
      max_tokens: maxTokens ?? 4000,
      messages: toAnthropicMessages(messages),
    };

    if (system) {
      // system + tools をまとめてプロンプトキャッシュ対象にする。
      // 討議は同じ役割プロンプトを何度も送るため効果が大きい。
      body.system = [
        { type: "text", text: system, cache_control: { type: "ephemeral" } },
      ];
    }
    if (tools?.length) {
      body.tools = tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      }));
    }

    const payload = await postJson({
      url: MESSAGES_URL,
      headers: headers(apiKey),
      body,
      signal,
      providerLabel: "Anthropic",
    });

    const blocks = payload.content ?? [];
    return {
      text: blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim(),
      toolCalls: blocks
        .filter((block) => block.type === "tool_use")
        .map((block) => ({
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        })),
      // 次ターンでそのまま履歴へ戻すための生ブロック。
      raw: blocks,
      usage: {
        input: payload.usage?.input_tokens ?? 0,
        output: payload.usage?.output_tokens ?? 0,
      },
    };
  },
};
