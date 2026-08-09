import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ROLE_META } from "../discussion/roles.js";

const PHASE_LABEL = {
  opening: "開会",
  debate: "討議",
  interjection: "中間整理",
  closing: "総括",
};

/**
 * 1発言のカード。左の綴じ側に役職名を縦組みで置き、
 * その発言で参照した資料を末尾に付す。
 */
function Statement({ statement }) {
  const meta = ROLE_META[statement.role];

  return (
    <article className="statement" data-accent={meta.accent}>
      <div className="statement-rail" aria-hidden="true">
        <span className="statement-role">{meta.name}</span>
        <span className="statement-round">
          {statement.round === 0 ? "開会" : String(statement.round).padStart(2, "0")}
        </span>
      </div>

      <div>
        <header className="statement-head">
          <span className="statement-speaker">
            {meta.name}・{statement.providerLabel}
          </span>
          <span className="statement-model">{statement.model}</span>
          <span className="statement-phase">{PHASE_LABEL[statement.phase]}</span>
        </header>

        <div className="statement-body">
          <Markdown remarkPlugins={[remarkGfm]}>{statement.text}</Markdown>
        </div>

        {statement.toolUses.length > 0 && (
          <div className="citations">
            {statement.toolUses.map((use) => (
              <span className="citation" data-source={use.source} key={use.id}>
                {use.source} · {use.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

export default Statement;
