import { getJson, postJson } from "./http.js";
import { toGeminiSchema } from "./schema.js";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function headers(apiKey) {
  return { "x-goog-api-key": apiKey };
}

/**
 * 中立メッセージをGeminiのcontents形式へ変換する。
 *
 * modelターンは raw（前回レスポンスのparts配列）をそのまま戻す。
 * Gemini 3系はfunctionCallに思考署名(thoughtSignature)を載せており、
 * これを欠いたまま履歴を再構成すると関数呼び出しの続きが成立しないため。
 */
function toGeminiContents(messages) {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        parts: message.results.map((result) => ({
          functionResponse: {
            ...(result.geminiId ? { id: result.geminiId } : {}),
            name: result.name,
            // responseはオブジェクトである必要がある。
            response: result.isError
              ? { error: result.content }
              : { result: result.content },
          },
        })),
      };
    }

    if (message.role === "assistant") {
      return {
        role: "model",
        parts: message.raw ?? [{ text: message.content ?? "" }],
      };
    }

    return { role: "user", parts: [{ text: message.content }] };
  });
}

function describeBlockedResponse(payload) {
  const candidate = payload.candidates?.[0];
  const reason = candidate?.finishReason;
  const blocked = payload.promptFeedback?.blockReason;

  if (blocked) {
    return `Geminiがプロンプトを拒否しました（${blocked}）。`;
  }
  if (reason === "MAX_TOKENS") {
    return "Geminiの出力が上限に達し、本文が返りませんでした。最大出力トークンを増やすか、発言の文字数指定を短くしてください。";
  }
  if (reason && reason !== "STOP") {
    return `Geminiが応答を中断しました（${reason}）。`;
  }
  return null;
}

export const geminiProvider = {
  id: "gemini",
  label: "Gemini",
  vendor: "Google",
  defaultModel: "gemini-3.6-flash",
  keyPlaceholder: "AIza...",
  consoleUrl: "https://aistudio.google.com/apikey",

  async listModels({ apiKey, signal }) {
    const payload = await getJson({
      url: `${BASE_URL}/models?pageSize=200`,
      headers: headers(apiKey),
      signal,
      providerLabel: "Gemini",
    });
    return (payload.models ?? [])
      .filter((model) =>
        (model.supportedGenerationMethods ?? []).includes("generateContent"),
      )
      .map((model) => ({
        // name は "models/gemini-3.6-flash" の形で返るため接頭辞を落とす。
        id: model.name.replace(/^models\//, ""),
        label: model.displayName ?? model.name,
      }));
  },

  async complete({ apiKey, model, system, messages, tools, maxTokens, signal }) {
    const body = {
      contents: toGeminiContents(messages),
      generationConfig: {
        // 思考トークンも同じ枠から消費されるため、本文が入る余裕を持たせる。
        maxOutputTokens: Math.max(maxTokens ?? 4000, 8192),
      },
    };

    if (system) {
      body.systemInstruction = { parts: [{ text: system }] };
    }
    if (tools?.length) {
      body.tools = [
        {
          functionDeclarations: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: toGeminiSchema(tool.parameters),
          })),
        },
      ];
    }

    const payload = await postJson({
      url: `${BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
      headers: headers(apiKey),
      body,
      signal,
      providerLabel: "Gemini",
    });

    const parts = payload.candidates?.[0]?.content?.parts ?? [];
    const toolCalls = parts
      .filter((part) => part.functionCall)
      .map((part, index) => ({
        id: part.functionCall.id ?? `${part.functionCall.name}-${index}`,
        geminiId: part.functionCall.id,
        name: part.functionCall.name,
        input: part.functionCall.args ?? {},
      }));

    const text = parts
      .filter((part) => typeof part.text === "string" && !part.thought)
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (!text && toolCalls.length === 0) {
      const reason = describeBlockedResponse(payload);
      if (reason) throw new Error(reason);
    }

    return {
      text,
      toolCalls,
      raw: parts,
      usage: {
        input: payload.usageMetadata?.promptTokenCount ?? 0,
        output: payload.usageMetadata?.candidatesTokenCount ?? 0,
      },
    };
  },
};
