import { TOOL_DEFINITIONS } from "./tool-defs.js";

/**
 * ツールの定義配布と実行を担う。
 *
 * LLMへ渡す定義は「中立形式」（{ name, description, parameters }）で、
 * ベンダー形式への変換は各アダプタが行う。
 */
export class ToolRegistry {
  #tools;
  #context;

  constructor({ estatAppId } = {}) {
    this.#tools = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
    this.#context = { estatAppId };
  }

  setContext(context) {
    this.#context = { ...this.#context, ...context };
  }

  /**
   * LLMへ渡すツール定義。e-Stat側はアプリケーションIDが無いと必ず失敗するため、
   * 未設定なら一覧から外し、使えないツールを提示しない。
   */
  definitions() {
    return [...this.#tools.values()]
      .filter((tool) => tool.source !== "e-Stat" || Boolean(this.#context.estatAppId))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));
  }

  describeTool(name, input) {
    const tool = this.#tools.get(name);
    if (!tool) return name;
    try {
      return tool.label?.(input ?? {}) ?? name;
    } catch {
      return name;
    }
  }

  sourceOf(name) {
    return this.#tools.get(name)?.source ?? "unknown";
  }

  /**
   * ツールを実行し、常に `{ content, dataset }` を返す。
   * contentはLLMへ返す文字列、datasetはCSV書き出し用の生データ（無ければnull）。
   * 契約をここに集約し、ハンドラが文字列だけを返しても壊れないようにする。
   */
  async execute(name, input, { signal } = {}) {
    const tool = this.#tools.get(name);
    if (!tool) {
      throw new Error(
        `未登録のツールです: ${name}。使えるのは ${[...this.#tools.keys()].join(", ")} です。`,
      );
    }

    const raw = await tool.handler(input ?? {}, { ...this.#context, signal });
    return typeof raw === "string"
      ? { content: raw, dataset: null }
      : { content: raw?.content ?? "", dataset: raw?.dataset ?? null };
  }
}
