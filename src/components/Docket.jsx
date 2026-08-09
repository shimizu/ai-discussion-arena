import { ROLE_META } from "../discussion/roles.js";

/**
 * 討議中に取得されたデータの一覧。
 * 誰がどの資料を出したかを残し、発言中の数値を原データまで辿れるようにする。
 */
function Docket({ evidence }) {
  return (
    <aside className="docket">
      <div className="docket-head">
        <h2>提出資料</h2>
        <span className="docket-count">{evidence.length} 件</span>
      </div>

      {evidence.length === 0 ? (
        <p className="docket-empty">
          討議中にAIがe-Statや世界銀行から取得したデータが、取得された順にここへ並びます。
        </p>
      ) : (
        <div className="docket-list">
          {evidence.map((item, index) => (
            <details className="exhibit" key={item.id}>
              <summary className="exhibit-summary">
                <span className="exhibit-index">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="exhibit-label">{item.label}</span>
              </summary>
              <p className="exhibit-meta">
                {item.source} / 提出: {ROLE_META[item.role].name}・{item.providerLabel}
              </p>
              <pre className="exhibit-content">{item.content}</pre>
            </details>
          ))}
        </div>
      )}
    </aside>
  );
}

export default Docket;
