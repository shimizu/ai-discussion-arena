import { getProvider } from "../llm/index.js";
import { ROLE, ROLE_META, assignRoles, buildSystemPrompt, buildTurnInstruction } from "./roles.js";

export const DEFAULT_MAX_ROUNDS = 6;
export const DEFAULT_MC_INTERVAL = 2;
const DEFAULT_MAX_TOOL_ITERATIONS = 4;

// 議事録に全文を載せる直近の発言数。それ以前は要旨だけにしてコンテキストを抑える。
const FULL_TEXT_WINDOW = 6;
const OLD_STATEMENT_CHARS = 220;

// 提出資料の一覧に載せる各資料の抜粋長。
const EVIDENCE_DIGEST_CHARS = 400;

// 議長が中間整理で討議を打ち切るときの合図。
const END_MARKER = "[討議終了]";

// リロードすると採番が1へ巻き戻る。保存済みの討議とIDが衝突しないよう、
// 読み込みごとのトークンを混ぜておく。
const RUN_TOKEN = Date.now().toString(36);
let sequence = 0;
const nextId = (prefix) => `${prefix}-${RUN_TOKEN}-${(sequence += 1)}`;

/**
 * これまでの発言を議事録テキストへ整形する。
 * 各AIには自分の内部履歴ではなくこの共有議事録を渡すので、
 * 3社のAPI形式の違いが討議そのものへ漏れない。
 */
function renderTranscript(statements) {
  if (statements.length === 0) return "（まだ発言はありません）";

  const cutoff = Math.max(0, statements.length - FULL_TEXT_WINDOW);

  return statements
    .map((statement, index) => {
      const head = `── 第${statement.round}巡 ${ROLE_META[statement.role].name}（${statement.providerLabel}）──`;
      if (index >= cutoff) return `${head}\n${statement.text}`;

      const digest =
        statement.text.length > OLD_STATEMENT_CHARS
          ? `${statement.text.slice(0, OLD_STATEMENT_CHARS)}…`
          : statement.text;
      return `${head}\n${digest}`;
    })
    .join("\n\n");
}

/**
 * 取得済みデータの一覧。誰かが取ったデータを全員が引用できるようにして、
 * 同じ統計を3回取りに行くことを防ぐ。
 */
function renderEvidence(evidence) {
  if (evidence.length === 0) return "（まだ資料は提出されていません）";

  return evidence
    .map((item, index) => {
      const digest =
        item.content.length > EVIDENCE_DIGEST_CHARS
          ? `${item.content.slice(0, EVIDENCE_DIGEST_CHARS)}…`
          : item.content;
      return `【資料${index + 1}】${item.label}（提出: ${ROLE_META[item.role].name} / 出典: ${item.source}）\n${digest}`;
    })
    .join("\n\n");
}

function buildTurnPrompt({ topic, participants, statements, evidence, phase, round, maxRounds }) {
  const roster = participants
    .map(({ role, providerLabel }) => `${ROLE_META[role].name}: ${providerLabel}`)
    .join(" / ");

  const progress =
    phase === "closing"
      ? `第${maxRounds}巡までの討議が終了しました。これは総括の発言です。`
      : `現在 第${round}巡 / 全${maxRounds}巡。`;

  return `# テーマ
${topic}

# 参加者
${roster}

# 進行
${progress}

# これまでの議事録
${renderTranscript(statements)}

# 提出済みの資料
${renderEvidence(evidence)}

# あなたへの指示
${buildTurnInstruction(phase)}`;
}

/**
 * 1人分の発言を生成する。
 * ツールを使う場合はこの関数の内部でモデル↔ツールの往復を完結させ、
 * ベンダー固有のツール履歴を討議本体へ持ち出さない。
 */
async function runTurn({
  participant,
  systemPrompt,
  prompt,
  registry,
  apiKeys,
  models,
  maxTokens,
  maxToolIterations,
  resolveProvider,
  signal,
  onEvent,
}) {
  const provider = resolveProvider(participant.providerId);
  const messages = [{ role: "user", content: prompt }];
  const toolUses = [];
  const usage = { input: 0, output: 0 };

  for (let iteration = 0; iteration <= maxToolIterations; iteration += 1) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    // 反復上限に達したらツールを外し、取得済みの情報だけで発言させる。
    const toolsForThisCall =
      iteration < maxToolIterations ? registry.definitions() : [];

    const response = await provider.complete({
      apiKey: apiKeys[provider.id],
      model: models[provider.id] || provider.defaultModel,
      system: systemPrompt,
      messages,
      tools: toolsForThisCall,
      maxTokens,
      signal,
    });

    usage.input += response.usage?.input ?? 0;
    usage.output += response.usage?.output ?? 0;

    if (response.toolCalls.length === 0) {
      return { text: response.text, toolUses, usage };
    }

    messages.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
      raw: response.raw,
    });

    const results = [];
    for (const call of response.toolCalls) {
      const label = registry.describeTool(call.name, call.input);
      onEvent({ type: "tool_start", participant, name: call.name, label });

      try {
        // registryは { content, dataset } を返す。モデルへ戻すのはcontentだけで、
        // datasetはCSV書き出し用に議事録側だけが持つ。
        const { content, dataset } = await registry.execute(call.name, call.input, {
          signal,
        });
        results.push({
          id: call.id,
          geminiId: call.geminiId,
          name: call.name,
          content,
        });

        const record = {
          id: nextId("evidence"),
          label,
          source: registry.sourceOf(call.name),
          tool: call.name,
          input: call.input,
          content,
          dataset,
          role: participant.role,
          providerLabel: provider.label,
        };
        toolUses.push(record);
        onEvent({ type: "tool_success", participant, name: call.name, label, record });
      } catch (error) {
        if (signal?.aborted) throw error;
        const message = error instanceof Error ? error.message : String(error);
        // ツール失敗は討議を止めず、モデルに再挑戦か方針転換をさせる。
        results.push({
          id: call.id,
          geminiId: call.geminiId,
          name: call.name,
          content: `エラー: ${message}`,
          isError: true,
        });
        onEvent({ type: "tool_error", participant, name: call.name, label, message });
      }
    }

    messages.push({ role: "tool", results });
  }

  return { text: "", toolUses, usage };
}

/**
 * 発言の順番表を作る。
 * 巡ごとに肯定側と否定側の先手を入れ替え、「常に後から反論できる」有利さを消す。
 * 議長は開会・一定間隔の中間整理・総括で登壇する。
 */
export function buildSchedule({ maxRounds, mcInterval }) {
  const schedule = [{ phase: "opening", role: ROLE.MC, round: 0 }];

  for (let round = 1; round <= maxRounds; round += 1) {
    const order =
      round % 2 === 1
        ? [ROLE.POSITIVE, ROLE.NEGATIVE]
        : [ROLE.NEGATIVE, ROLE.POSITIVE];

    for (const role of order) {
      schedule.push({ phase: "debate", role, round });
    }

    if (mcInterval > 0 && round % mcInterval === 0 && round < maxRounds) {
      schedule.push({ phase: "interjection", role: ROLE.MC, round });
    }
  }

  schedule.push({ phase: "closing", role: ROLE.MC, round: maxRounds + 1 });
  return schedule;
}

/**
 * 討議を最後まで進行する。
 * 進捗はonEventで通知し、UIは戻り値を待たずに描画できるようにする。
 */
export async function runDiscussion({
  topic,
  providerIds,
  apiKeys,
  models,
  registry,
  maxRounds = DEFAULT_MAX_ROUNDS,
  mcInterval = DEFAULT_MC_INTERVAL,
  maxTokens = 4000,
  maxToolIterations = DEFAULT_MAX_TOOL_ITERATIONS,
  rng = Math.random,
  // テストではネットワークを持たない偽プロバイダを差し込む。
  resolveProvider = getProvider,
  signal,
  onEvent = () => {},
}) {
  const assignments = assignRoles(providerIds, rng);
  const participants = assignments.map(({ role, providerId }) => {
    const provider = resolveProvider(providerId);
    return {
      role,
      providerId,
      providerLabel: provider.label,
      vendor: provider.vendor,
      model: models[providerId] || provider.defaultModel,
    };
  });
  const participantByRole = Object.fromEntries(
    participants.map((participant) => [participant.role, participant]),
  );

  onEvent({ type: "roles_assigned", participants });

  const systemPrompts = Object.fromEntries(
    participants.map((participant) => [
      participant.role,
      buildSystemPrompt({ role: participant.role, topic, participants }),
    ]),
  );

  const statements = [];
  const evidence = [];
  const schedule = buildSchedule({ maxRounds, mcInterval });

  for (let index = 0; index < schedule.length; index += 1) {
    const step = schedule[index];
    if (signal?.aborted) return { status: "aborted", statements, evidence, participants };

    const participant = participantByRole[step.role];
    onEvent({ type: "turn_start", participant, phase: step.phase, round: step.round });

    let result;
    try {
      result = await runTurn({
        participant,
        systemPrompt: systemPrompts[step.role],
        prompt: buildTurnPrompt({
          topic,
          participants,
          statements,
          evidence,
          phase: step.phase,
          round: step.round,
          maxRounds,
        }),
        registry,
        apiKeys,
        models,
        maxTokens,
        maxToolIterations,
        resolveProvider,
        signal,
        onEvent,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        return { status: "aborted", statements, evidence, participants };
      }
      // 1人が落ちても討議全体は続ける。誰の発言が失敗したかは議事録に残す。
      const message = error instanceof Error ? error.message : String(error);
      onEvent({ type: "turn_error", participant, phase: step.phase, round: step.round, message });
      continue;
    }

    const cleanedText = result.text.replace(END_MARKER, "").trim();
    if (!cleanedText) {
      onEvent({
        type: "turn_error",
        participant,
        phase: step.phase,
        round: step.round,
        message: "本文が空のまま返されました。モデル設定を確認してください。",
      });
      continue;
    }

    const statement = {
      id: nextId("statement"),
      role: step.role,
      phase: step.phase,
      round: step.round,
      providerId: participant.providerId,
      providerLabel: participant.providerLabel,
      model: participant.model,
      text: cleanedText,
      toolUses: result.toolUses,
      usage: result.usage,
    };
    statements.push(statement);
    evidence.push(...result.toolUses);
    onEvent({ type: "turn_end", statement });

    // 議長が早期終了を宣言したら、残りの巡を飛ばして総括へ移る。
    if (step.phase === "interjection" && result.text.includes(END_MARKER)) {
      onEvent({ type: "early_close", round: step.round });
      const closing = schedule[schedule.length - 1];
      index = schedule.length - 2;
      schedule[schedule.length - 1] = { ...closing, round: step.round + 1 };
    }
  }

  onEvent({ type: "finished" });
  return { status: "completed", statements, evidence, participants };
}
