import { useEffect, useMemo, useRef, useState } from "react";
import ApiSettings from "./components/ApiSettings.jsx";
import Docket from "./components/Docket.jsx";
import Statement from "./components/Statement.jsx";
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_MC_INTERVAL,
  runDiscussion,
} from "./discussion/engine.js";
import { ROLE_META } from "./discussion/roles.js";
import { PROVIDERS } from "./llm/index.js";
import { ToolRegistry } from "./tools/registry.js";

const STORAGE_PREFIX = "ai-discussion.";
const ESTAT_KEY = `${STORAGE_PREFIX}estatAppId`;
const TOPIC_KEY = `${STORAGE_PREFIX}topic`;
const keyStorageId = (providerId) => `${STORAGE_PREFIX}key.${providerId}`;
const modelStorageId = (providerId) => `${STORAGE_PREFIX}model.${providerId}`;

// localStorageはプライベートモードや設定次第で例外を投げるため、常に保護して読み書きする。
function loadSetting(key, fallback = "") {
  try {
    return globalThis.localStorage?.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // 保存できなくてもメモリ上の状態で動作は継続する。
  }
}

function removeSetting(key) {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    // 削除失敗は無視する。
  }
}

function loadRecord(makeKey, fallback) {
  return Object.fromEntries(
    PROVIDERS.map((provider) => [
      provider.id,
      loadSetting(makeKey(provider.id), fallback(provider)),
    ]),
  );
}

const PHASE_LABEL = {
  opening: "開会の発言を準備しています",
  debate: "発言を組み立てています",
  interjection: "議論を整理しています",
  closing: "総括を作成しています",
};

function App() {
  const [apiKeys, setApiKeys] = useState(() => loadRecord(keyStorageId, () => ""));
  const [models, setModels] = useState(() =>
    loadRecord(modelStorageId, (provider) => provider.defaultModel),
  );
  const [estatAppId, setEstatAppId] = useState(() => loadSetting(ESTAT_KEY));
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [topic, setTopic] = useState(() => loadSetting(TOPIC_KEY));
  const [maxRounds, setMaxRounds] = useState(DEFAULT_MAX_ROUNDS);
  const [mcInterval, setMcInterval] = useState(DEFAULT_MC_INTERVAL);

  const [running, setRunning] = useState(false);
  const [participants, setParticipants] = useState([]);
  const [statements, setStatements] = useState([]);
  const [evidence, setEvidence] = useState([]);
  const [activity, setActivity] = useState(null);
  const [turnErrors, setTurnErrors] = useState([]);
  const [notice, setNotice] = useState("");

  const abortRef = useRef(null);
  const liveRef = useRef(null);

  const availableProviderIds = useMemo(
    () => PROVIDERS.filter((provider) => apiKeys[provider.id]?.trim()).map((p) => p.id),
    [apiKeys],
  );

  // 進行中の発言者が変わったら、その位置まで自動で追従する。
  useEffect(() => {
    if (!activity || !liveRef.current) return;
    liveRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activity]);

  const handleApiKeyChange = (providerId, value) => {
    setApiKeys((current) => ({ ...current, [providerId]: value }));
    if (value) saveSetting(keyStorageId(providerId), value);
    else removeSetting(keyStorageId(providerId));
  };

  const handleModelChange = (providerId, value) => {
    setModels((current) => ({ ...current, [providerId]: value }));
    saveSetting(modelStorageId(providerId), value);
  };

  const handleEstatAppIdChange = (value) => {
    setEstatAppId(value);
    if (value) saveSetting(ESTAT_KEY, value);
    else removeSetting(ESTAT_KEY);
  };

  const handleClearAll = () => {
    for (const provider of PROVIDERS) {
      removeSetting(keyStorageId(provider.id));
    }
    removeSetting(ESTAT_KEY);
    setApiKeys(Object.fromEntries(PROVIDERS.map((provider) => [provider.id, ""])));
    setEstatAppId("");
  };

  const handleStop = () => {
    abortRef.current?.abort();
  };

  const handleStart = async () => {
    const trimmedTopic = topic.trim();
    if (!trimmedTopic) {
      setNotice("討議のテーマを入力してください。");
      return;
    }
    if (availableProviderIds.length === 0) {
      setNotice("APIキーが1つも登録されていません。API設定から登録してください。");
      setSettingsOpen(true);
      return;
    }

    saveSetting(TOPIC_KEY, trimmedTopic);
    setNotice("");
    setStatements([]);
    setEvidence([]);
    setParticipants([]);
    setTurnErrors([]);
    setActivity(null);
    setRunning(true);

    const controller = new AbortController();
    abortRef.current = controller;
    const registry = new ToolRegistry({ estatAppId: estatAppId.trim() });

    try {
      await runDiscussion({
        topic: trimmedTopic,
        providerIds: availableProviderIds,
        apiKeys,
        models,
        registry,
        maxRounds,
        mcInterval,
        signal: controller.signal,
        onEvent: (event) => {
          switch (event.type) {
            case "roles_assigned":
              setParticipants(event.participants);
              break;
            case "turn_start":
              setActivity({
                participant: event.participant,
                phase: event.phase,
                detail: PHASE_LABEL[event.phase],
              });
              break;
            case "tool_start":
              setActivity((current) =>
                current
                  ? { ...current, detail: `${event.label} を照会しています` }
                  : current,
              );
              break;
            case "tool_success":
              setEvidence((current) => [...current, event.record]);
              setActivity((current) =>
                current
                  ? { ...current, detail: `${event.label} を読み込みました` }
                  : current,
              );
              break;
            case "tool_error":
              setActivity((current) =>
                current
                  ? { ...current, detail: `${event.label} の取得に失敗しました` }
                  : current,
              );
              break;
            case "turn_end":
              setStatements((current) => [...current, event.statement]);
              setActivity(null);
              break;
            case "turn_error":
              setTurnErrors((current) => [
                ...current,
                {
                  id: `${event.round}-${event.participant.role}-${current.length}`,
                  role: event.participant.role,
                  providerLabel: event.participant.providerLabel,
                  message: event.message,
                },
              ]);
              setActivity(null);
              break;
            default:
              break;
          }
        },
      });
    } catch (error) {
      if (error?.name !== "AbortError") {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setActivity(null);
      setRunning(false);
      abortRef.current = null;
    }
  };

  const handleExport = () => {
    const lines = [
      `# 討議記録: ${topic.trim()}`,
      "",
      "## 参加者",
      ...participants.map(
        (participant) =>
          `- ${ROLE_META[participant.role].name}: ${participant.providerLabel}（${participant.model}）`,
      ),
      "",
      "## 議事録",
      "",
    ];

    for (const statement of statements) {
      lines.push(
        `### 第${statement.round}巡 ${ROLE_META[statement.role].name}（${statement.providerLabel}）`,
        "",
        statement.text,
        "",
      );
      if (statement.toolUses.length > 0) {
        lines.push(
          `参照: ${statement.toolUses.map((use) => `${use.source} ${use.label}`).join(" / ")}`,
          "",
        );
      }
    }

    if (evidence.length > 0) {
      lines.push("## 提出資料", "");
      evidence.forEach((item, index) => {
        lines.push(
          `### 資料${index + 1}: ${item.label}`,
          `出典: ${item.source} / 提出: ${ROLE_META[item.role].name}`,
          "",
          "```",
          item.content,
          "```",
          "",
        );
      });
    }

    const blob = new Blob([lines.join("\n")], {
      type: "text/markdown;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `討議記録_${topic.trim().slice(0, 24) || "untitled"}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const totalTurns = maxRounds * 2 + 2 + Math.max(0, Math.floor((maxRounds - 1) / Math.max(mcInterval, 1)));
  const progress = Math.min(100, (statements.length / Math.max(totalTurns, 1)) * 100);

  return (
    <div className="shell">
      <header className="masthead">
        <div className="masthead-title">
          <h1>円卓</h1>
          <span className="masthead-sub">AI discussion · e-Stat / World Bank</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {statements.length > 0 && !running && (
            <button type="button" className="btn" onClick={handleExport}>
              議事録を保存
            </button>
          )}
          <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>
            API設定
          </button>
        </div>
      </header>

      <section className="podium">
        <label className="podium-label" htmlFor="topic">
          討議テーマ
        </label>
        <div className="podium-row">
          <textarea
            id="topic"
            className="podium-input"
            rows={2}
            value={topic}
            disabled={running}
            placeholder="例: 日本は移民受け入れを大幅に拡大すべきか"
            onChange={(event) => setTopic(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                handleStart();
              }
            }}
          />
          {running ? (
            <button type="button" className="btn btn-stop" onClick={handleStop}>
              討議を止める
            </button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={handleStart}>
              討議を始める
            </button>
          )}
        </div>

        <div className="podium-controls">
          <label className="dial">
            巡回数の上限
            <input
              type="number"
              min="1"
              max="30"
              value={maxRounds}
              disabled={running}
              onChange={(event) =>
                setMaxRounds(Math.max(1, Number(event.target.value) || 1))
              }
            />
          </label>
          <label className="dial">
            議長が整理に入る間隔
            <input
              type="number"
              min="0"
              max="10"
              value={mcInterval}
              disabled={running}
              onChange={(event) =>
                setMcInterval(Math.max(0, Number(event.target.value) || 0))
              }
            />
          </label>
          <span className="dial" style={{ color: "var(--text-faint)" }}>
            {maxRounds}巡を終えると議長が総括に入ります
          </span>
        </div>

        {notice && <p className="notice">{notice}</p>}
      </section>

      {participants.length > 0 && (
        <>
          <div className="roster">
            {participants.map((participant) => (
              <div
                className="roster-seat"
                data-accent={ROLE_META[participant.role].accent}
                key={participant.role}
              >
                <span className="roster-role">{ROLE_META[participant.role].name}</span>
                <span className="roster-provider">{participant.providerLabel}</span>
                <span className="roster-model">{participant.model}</span>
              </div>
            ))}
          </div>

          <div className="proceedings">
            <span>発言 {statements.length}</span>
            <div className="proceedings-track">
              <div className="proceedings-fill" style={{ width: `${progress}%` }} />
            </div>
            <span>資料 {evidence.length}</span>
          </div>
        </>
      )}

      <div className="floor">
        <main>
          {statements.length === 0 && !running && (
            <div className="empty">
              <div className="empty-mark">円卓</div>
              <p>
                テーマを入力して討議を始めると、登録されたAIに議長・肯定側・否定側の役が
                ランダムに割り当てられます。三者は必要に応じてe-Statと世界銀行のデータを
                取りに行き、それを根拠として論を組み立てます。合意に至るとは限りません。
              </p>
            </div>
          )}

          {statements.map((statement) => (
            <Statement statement={statement} key={statement.id} />
          ))}

          {turnErrors.map((error) => (
            <p className="turn-error" key={error.id}>
              {ROLE_META[error.role].name}（{error.providerLabel}）の発言に失敗しました:{" "}
              {error.message}
            </p>
          ))}

          {activity && (
            <div
              className="speaking"
              data-accent={ROLE_META[activity.participant.role].accent}
              ref={liveRef}
              aria-live="polite"
            >
              <div className="statement-rail" aria-hidden="true">
                <span className="statement-role">
                  {ROLE_META[activity.participant.role].name}
                </span>
              </div>
              <div className="speaking-body">
                <span className="pulse" />
                <span>
                  {activity.participant.providerLabel} が{activity.detail}
                </span>
              </div>
            </div>
          )}
        </main>

        <Docket evidence={evidence} />
      </div>

      {settingsOpen && (
        <ApiSettings
          apiKeys={apiKeys}
          models={models}
          estatAppId={estatAppId}
          onApiKeyChange={handleApiKeyChange}
          onModelChange={handleModelChange}
          onEstatAppIdChange={handleEstatAppIdChange}
          onClose={() => setSettingsOpen(false)}
          onClearAll={handleClearAll}
        />
      )}
    </div>
  );
}

export default App;
