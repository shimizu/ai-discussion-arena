import { anthropicProvider } from "./anthropic.js";
import { geminiProvider } from "./gemini.js";
import { openaiProvider } from "./openai.js";

/**
 * 中立メッセージ形式
 * -------------------------------------------------------------------
 * 討議エンジンはこの形式だけを扱い、各社の差はアダプタが吸収する。
 *
 *   { role: "user",      content: string }
 *   { role: "assistant", content: string, toolCalls: ToolCall[], raw: any }
 *   { role: "tool",      results: ToolResult[] }
 *
 *   ToolCall   = { id, name, input, geminiId? }
 *   ToolResult = { id, name, content, isError?, geminiId? }
 *
 * assistantの raw には各社のレスポンス断片をそのまま入れる。
 * これを次のリクエストへ戻すことで、ツール呼び出しIDやGeminiの思考署名など
 * 「再構成できない情報」を失わずに済む。
 *
 * providerの complete() は次を返す:
 *   { text, toolCalls, raw, usage: { input, output } }
 */

export const PROVIDERS = [anthropicProvider, openaiProvider, geminiProvider];

export const PROVIDER_BY_ID = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.id, provider]),
);

export function getProvider(id) {
  const provider = PROVIDER_BY_ID[id];
  if (!provider) throw new Error(`未知のプロバイダです: ${id}`);
  return provider;
}
