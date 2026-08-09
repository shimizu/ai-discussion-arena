import { useEffect, useMemo, useRef, useState } from "react";
import ApiSettings from "./components/ApiSettings.jsx";
import Docket from "./components/Docket.jsx";
import Statement from "./components/Statement.jsx";
import {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_MC_INTERVAL,
  runDiscussion,
} from "./discussion/engine.js";
import {
  buildEvidenceCsv,
  buildExportBaseName,
  buildMinutesMarkdown,
} from "./discussion/export.js";
import { ROLE_META } from "./discussion/roles.js";
import { PROVIDERS } from "./llm/index.js";
import {
  STORAGE_PREFIX,
  loadSetting,
  removeSetting,
  saveSetting,
} from "./storage/local.js";
import { clearSession, loadSession, saveSession } from "./storage/session.js";
import { ToolRegistry } from "./tools/registry.js";
import { downloadTextFile } from "./utils/download.js";

const ESTAT_KEY = `${STORAGE_PREFIX}estatAppId`;
const TOPIC_KEY = `${STORAGE_PREFIX}topic`;
const keyStorageId = (providerId) => `${STORAGE_PREFIX}key.${providerId}`;
const modelStorageId = (providerId) => `${STORAGE_PREFIX}model.${providerId}`;

// PROVIDERSに依存するため、localStorageのプリミティブとは分けてここに置く。
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

// 保存のたびに議事録全体を直列化するので、発言と資料が連続して増える場面では
// 一拍おいてまとめて書く。
const SAVE_DEBOUNCE_MS = 400;

// UTF-8のBOM。CSVの先頭に付ける。
const UTF8_BOM = String.fromCharCode(0xfeff);

function App() {
  // MB級になりうるので、復元データの読み込みとパースはマウント時の1回だけ。
  const [restored] = useState(loadSession);
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
  const [activity, setActivity] = useState(null);
  const [notice, setNotice] = useState("");

  // 表示中の討議。入力欄のtopic（下書き）とは分けて持つ。
  // 入力欄を書き換えても、すでに終わった討議の書き出しタイトルが変わらないようにするため。
  const [discussionTopic, setDiscussionTopic] = useState(() => restored?.topic ?? "");
  const [participants, setParticipants] = useState(() => restored?.participants ?? []);
  const [statements, setStatements] = useState(() => restored?.statements ?? []);
  const [evidence, setEvidence] = useState(() => restored?.evidence ?? []);
  const [turnErrors, setTurnErrors] = useState(() => restored?.turnErrors ?? []);

  // running のまま保存されていたら、討議中にページが閉じられたということ。
  const [sessionStatus, setSessionStatus] = useState(() =>
    restored?.status === "running" ? "interrupted" : (restored?.status ?? "idle"),
  );

  const abortRef = useRef(null);
  const liveRef = useRef(null);
  const saveTimerRef = useRef(null);
  const storageWarnedRef = useRef(false);

  const availableProviderIds = useMemo(
    () => PROVIDERS.filter((provider) => apiKeys[provider.id]?.trim()).map((p) => p.id),
    [apiKeys],
  );

  // 進行中の発言者が変わったら、その位置まで自動で追従する。
  useEffect(() => {
    if (!activity || !liveRef.current) return;
    liveRef.current.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activity]);

  // 中断された討議を復元したことは、黙って表示すると気づけないので明示する。
  // 復元後は status が interrupted で保存し直されるため、両方を見る。
  useEffect(() => {
    if (restored?.status === "running" || restored?.status === "interrupted") {
      setNotice(
        "前回の討議は途中で中断されています。そこまでの記録は復元しましたが、続きからの再開はできません。",
      );
    }
  }, [restored]);

  // 討議の状態をブラウザへ保存する。
  // 発言と資料は続けて増えるので、一拍おいてからまとめて書く。
  // タブを閉じるときはunmountが走らないため、pagehideで書き残しを流し込む。
  useEffect(() => {
    if (statements.length === 0 && evidence.length === 0) return undefined;

    const flush = () => {
      clearTimeout(saveTimerRef.current);
      const result = saveSession({
        topic: discussionTopic,
        status: sessionStatus,
        participants,
        statements,
        evidence,
        turnErrors,
      });

      if (storageWarnedRef.current) return;
      if (!result.ok) {
        storageWarnedRef.current = true;
        setNotice(
          "ブラウザの保存容量が不足しているため、討議記録を自動保存できません。議事録とデータを出力しておいてください。",
        );
      } else if (result.degraded !== "none") {
        storageWarnedRef.current = true;
        setNotice(
          "保存容量の都合で、古い資料のデータは一部しか保存されていません。今のうちにデータを出力（CSV）しておいてください。",
        );
      }
    };

    saveTimerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
    window.addEventListener("pagehide", flush);

    return () => {
      clearTimeout(saveTimerRef.current);
      window.removeEventListener("pagehide", flush);
    };
  }, [
    discussionTopic,
    sessionStatus,
    participants,
    statements,
    evidence,
    turnErrors,
  ]);

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
    // 討議本文もブラウザに残るようになったので、キーと一緒に消す。
    clearTimeout(saveTimerRef.current);
    clearSession();
    setApiKeys(Object.fromEntries(PROVIDERS.map((provider) => [provider.id, ""])));
    setEstatAppId("");
    setDiscussionTopic("");
    setParticipants([]);
    setStatements([]);
    setEvidence([]);
    setTurnErrors([]);
    setSessionStatus("idle");
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

    // 保留中の保存を先に止める。順序を誤ると、消した直後に
    // 古い状態の保存が発火してセッションが書き戻ってしまう。
    clearTimeout(saveTimerRef.current);
    clearSession();
    storageWarnedRef.current = false;

    setNotice("");
    setStatements([]);
    setEvidence([]);
    setParticipants([]);
    setTurnErrors([]);
    setActivity(null);
    setDiscussionTopic(trimmedTopic);
    setSessionStatus("running");
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
                  round: event.round,
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
      setSessionStatus(controller.signal.aborted ? "aborted" : "completed");
      abortRef.current = null;
    }
  };

  // 議事録とデータで同じ基底名を使い、.md と .csv が対になるようにする。
  const exportPayload = () => ({
    topic: discussionTopic,
    participants,
    statements,
    evidence,
    turnErrors,
    status: sessionStatus,
    exportedAt: new Date(),
  });

  const handleExportMinutes = () => {
    const payload = exportPayload();
    downloadTextFile(
      `${buildExportBaseName(discussionTopic, payload.exportedAt)}.md`,
      buildMinutesMarkdown(payload),
      "text/markdown;charset=utf-8",
    );
  };

  const handleExportCsv = () => {
    const payload = exportPayload();
    downloadTextFile(
      `${buildExportBaseName(discussionTopic, payload.exportedAt)}.csv`,
      // BOMを付けないと、日本語版ExcelがシフトJISとして開いて文字化けする。
      `${UTF8_BOM}${buildEvidenceCsv(payload)}`,
      "text/csv;charset=utf-8",
    );
  };

  const totalTurns = maxRounds * 2 + 2 + Math.max(0, Math.floor((maxRounds - 1) / Math.max(mcInterval, 1)));
  const progress = Math.min(100, (statements.length / Math.max(totalTurns, 1)) * 100);

  return (
    <div className="shell">
      <header className="masthead">
        <div className="masthead-title">
          <h1>AI円卓</h1>
          <span className="masthead-sub">AI discussion · e-Stat / World Bank</span>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          {statements.length > 0 && !running && (
            <button type="button" className="btn" onClick={handleExportMinutes}>
              議事録を出力
            </button>
          )}
          {evidence.length > 0 && !running && (
            <button type="button" className="btn" onClick={handleExportCsv}>
              データを出力
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
            placeholder="ここにテーマを入力してください"
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
