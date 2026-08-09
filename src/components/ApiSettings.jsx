import { useState } from "react";
import { PROVIDERS } from "../llm/index.js";

/**
 * モデル名はベンダー側で頻繁に変わるため、手入力に加えて
 * 各社のモデル一覧APIから取得して選べるようにする。
 * キーが正しいかどうかの確認も兼ねる。
 */
function ModelField({ provider, apiKey, model, onModelChange }) {
  const [options, setOptions] = useState(null);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");

  const loadModels = async () => {
    setStatus("loading");
    setError("");
    try {
      const models = await provider.listModels({ apiKey });
      setOptions(models);
      setStatus("loaded");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setStatus("idle");
    }
  };

  return (
    <label className="field">
      <span className="field-label">モデル</span>
      <div className="model-row">
        {options ? (
          <select
            className="field-select"
            value={model}
            onChange={(event) => onModelChange(event.target.value)}
          >
            {/* 取得一覧に無い値を設定済みでも消えないようにしておく。 */}
            {!options.some((option) => option.id === model) && (
              <option value={model}>{model}</option>
            )}
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.id}
              </option>
            ))}
          </select>
        ) : (
          <input
            className="field-input"
            type="text"
            value={model}
            spellCheck="false"
            onChange={(event) => onModelChange(event.target.value)}
          />
        )}
        <button
          type="button"
          className="btn"
          onClick={loadModels}
          disabled={!apiKey || status === "loading"}
        >
          {status === "loading" ? "取得中" : "一覧を取得"}
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
      {!error && status === "loaded" && (
        <p className="field-help">{options.length}件のモデルが利用できます。</p>
      )}
    </label>
  );
}

function ApiSettings({
  apiKeys,
  models,
  estatAppId,
  onApiKeyChange,
  onModelChange,
  onEstatAppIdChange,
  onClose,
  onClearAll,
}) {
  return (
    <div
      className="settings-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="API設定"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="settings">
        <h2>API設定</h2>
        <p className="settings-lede">
          キーを登録したAIが討議に参加します。3社そろえば議長・肯定側・否定側が
          それぞれ別のAIになり、2社以下のときは1つのAIが複数の役を兼ねます。
          キーはこのブラウザのlocalStorageにのみ保存され、各社のAPI以外へは送信されません。
        </p>

        {PROVIDERS.map((provider) => (
          <div className="provider-card" key={provider.id}>
            <div className="provider-card-head">
              <span className="provider-name">{provider.label}</span>
              <span className="provider-vendor">{provider.vendor}</span>
            </div>

            <label className="field">
              <span className="field-label">APIキー</span>
              <input
                className="field-input"
                type="password"
                autoComplete="off"
                spellCheck="false"
                placeholder={provider.keyPlaceholder}
                value={apiKeys[provider.id] ?? ""}
                onChange={(event) =>
                  onApiKeyChange(provider.id, event.target.value)
                }
              />
              <p className="field-help">
                <a href={provider.consoleUrl} target="_blank" rel="noopener noreferrer">
                  {provider.vendor}のコンソール
                </a>
                で発行できます。
              </p>
            </label>

            <ModelField
              provider={provider}
              apiKey={apiKeys[provider.id] ?? ""}
              model={models[provider.id] ?? provider.defaultModel}
              onModelChange={(value) => onModelChange(provider.id, value)}
            />
          </div>
        ))}

        <div className="provider-card">
          <div className="provider-card-head">
            <span className="provider-name">e-Stat</span>
            <span className="provider-vendor">政府統計の総合窓口</span>
          </div>
          <label className="field">
            <span className="field-label">アプリケーションID</span>
            <input
              className="field-input"
              type="password"
              autoComplete="off"
              spellCheck="false"
              placeholder="e-Stat の appId"
              value={estatAppId}
              onChange={(event) => onEstatAppIdChange(event.target.value)}
            />
            <p className="field-help">
              <a
                href="https://www.e-stat.go.jp/api/"
                target="_blank"
                rel="noopener noreferrer"
              >
                e-Stat API
              </a>
              で取得します。未設定の場合、討議では世界銀行のデータだけが使われます。
            </p>
          </label>
        </div>

        <div className="settings-actions">
          <button type="button" className="btn btn-primary" onClick={onClose}>
            閉じる
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClearAll}>
            保存したキーをすべて削除
          </button>
        </div>
      </div>
    </div>
  );
}

export default ApiSettings;
