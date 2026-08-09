# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## コマンド

```bash
npm install
npm run dev          # Vite dev server → http://localhost:3100
npm run build        # dist/ へ本番ビルド（CSPのmetaが注入される）
npm run preview      # ビルド成果物を :3100 で確認
npm test             # node --test test/*.test.js
```

単体でテストを走らせる場合:

```bash
node --test test/adapters.test.js
node --test --test-name-pattern="思考署名" test/adapters.test.js
```

テストランナーは Node 標準の `node:test`。ビルドツールを通さず `src/` の ESM を
直接importするため、テストからはブラウザAPIが使えない点に注意（`fetch` はテスト内でスタブする）。

## アーキテクチャ

サーバーレスのブラウザアプリ。React + Vite のみで、バックエンドは無い。
APIキーと討議記録は `localStorage`（`ai-discussion.` プレフィックス）にのみ保存され、
ブラウザから各社APIを直接叩く。

### 3層構造

```
components/  ─→  discussion/  ─→  llm/       （3社のAPI差を吸収）
                              └─→  tools/    （e-Stat / World Bank）
                 storage/                    （localStorageへの永続化）
                 utils/                      （ダウンロード）
```

**`src/llm/` — プロバイダアダプタ層**

`index.js` に定義された「中立メッセージ形式」だけが層を跨ぐ:

```js
{ role: "user",      content: string }
{ role: "assistant", content: string, toolCalls: ToolCall[], raw: any }
{ role: "tool",      results: ToolResult[] }
```

`complete()` は `{ text, toolCalls, raw, usage }` を返す。

**`raw` が設計の核心**: 各社レスポンスの生断片（Anthropicのcontentブロック、
OpenAIの `output` 配列、Geminiの `parts` 配列）をそのまま保持し、次リクエストへ
丸ごと戻す。ツール呼び出しIDの対応、OpenAIの推論アイテムの順序、Gemini 3系の
思考署名（`thoughtSignature`）は再構成できないため、履歴を組み直してはならない。
アダプタを触るときはこの原則を壊さないこと。

新しいプロバイダを足す場合は `src/llm/*.js` にモジュールを作り、`PROVIDERS` 配列へ追加する
（`id` / `label` / `vendor` / `defaultModel` / `listModels` / `complete` を実装）。
UIとストレージキーは `PROVIDERS` から自動で派生する。CSPの `connect-src`
（`vite.config.js`）にホストを追加する必要もある。

**`src/tools/` — データ取得層**

ツール定義は `tool-defs.js` に中立形式（JSON Schema相当）で **1回だけ** 書く。
ベンダー形式への変換は `llm/schema.js`（`toGeminiSchema` / `toOpenAiParameters`）が行う。
3社ぶん定義を書き分けると必ずズレるため、定義の重複は作らないこと。

`ToolRegistry` は e-Stat のアプリケーションIDが未設定なら e-Stat 系ツールを
`definitions()` から除外する（使えないツールをモデルへ見せない）。

**`ToolRegistry.execute()` は必ず `{ content, dataset }` を返す。** ここが契約の唯一の番人で、
ハンドラが文字列だけを返しても正規化される。

```js
content  // LLMへ返す文字列。表示は40行まで、数値はロケール整形（1,234）
dataset  // CSV書き出し用。{ columns, rows, totalRows, note? }
```

**`dataset` の値はロケール整形してはならない**（`number | string | null` の生値）。
`1,234` のようなカンマ入り文字列は表計算ソフトが数値として読まない。
逆に `content` は読みやすさ優先で整形する。両者は `tool-defs.js` の同じハンドラ内で
作り分けるが、列の選び方など共有できるものは関数に切り出して重複させない
（例: `selectEstatColumns`）。`dataset` は `content` より多くの行を持てるが、
`DATASET_MAX_ROWS` で有界にする（e-Statの `maxRecords` にもWorld Bankの
`per_page` にも上限が無いため）。

**`src/discussion/` — 討議進行**

- `roles.js`: 議長 / 肯定側 / 否定側 のsystem prompt、フェーズ別指示、役割のランダム割り当て。
  プロバイダが3未満なら1つが複数役を兼任する。乱数は注入可能（テスト用）。
- `engine.js`: `buildSchedule()` が進行表を作り、`runDiscussion()` が実行する。
- `export.js`: 議事録のMarkdownと取得データのCSVを組み立てる。純粋関数で、
  ダウンロード自体は `utils/download.js` が行う。

**`src/storage/` — 永続化**

- `local.js`: localStorageのプリミティブ。`saveSetting` は成否を `boolean` で返す
  （localStorage不在を「成功」と報告しないよう、オプショナルチェーンだけで済ませない）。
- `session.js`: 討議1件分の保存・復元・破棄。次の3点が要。
  1. **2キーに分ける** — `session`（発言ごとに書き換わるが小さい）と
     `datasets`（資料取得時のみ変わるが大きい）。
  2. **`toolUses` を縮約する** — `statements[].toolUses` と `evidence` は engine が作る
     **同一オブジェクト参照**。そのまま直列化すると行データが2回書き出される。
     保存時は `{ id, source, label }` の3つだけに落とす。
  3. **復元時にサニタイズする** — Appにエラーバウンダリが無く、未知の role は
     `ROLE_META[role].name` でアプリ全体を落とす。`sanitizeSession()` を必ず通す。

  容量超過は**エラー名で分岐しない**（Chrome / Firefox / Safari で名前が違う）。
  投げられたら劣化、という catch-all にし、劣化は事前バジェット方式で決める。

### 討議エンジンの不変条件

これらを崩すとテストが落ちるだけでなく設計意図が壊れる:

1. **共有議事録方式** — 各AIには自分の会話履歴ではなく、全員分の発言を整形した
   テキスト（`renderTranscript`）を毎ターン `user` メッセージとして渡す。
   `messages` は1ターンごとに作り直され、ターンを跨いで持ち越さない。
2. **ツール往復は1ターン内で完結** — `runTurn()` の中でモデル↔ツールのループを閉じ、
   ベンダー固有のツール履歴を討議本体へ出さない。反復上限
   （`DEFAULT_MAX_TOOL_ITERATIONS`）に達したらツールを外して最終発言だけ書かせる。
3. **資料の共有** — 誰かが取得したデータは `evidence` に蓄積され、以降の全発言者の
   プロンプトに載る。同じ統計を3人が別々に取りに行くことを防ぐ。
4. **先手の入れ替え** — 奇数巡は肯定側→否定側、偶数巡は逆。
5. **部分的な失敗を許容** — 1人の発言が失敗しても `continue` して討議を続ける。
   ツール失敗はエラー文字列をモデルへ返し、モデルに判断させる。
   中断（AbortError）だけは全体を止める。
6. **早期終了** — 議長が中間整理で `[討議終了]`（`END_MARKER`）を書くと、
   残りの巡を飛ばして総括へ移る。マーカーは表示テキストから除去される。

進捗は `onEvent` コールバックで通知する（`roles_assigned` / `turn_start` /
`tool_start` / `tool_success` / `tool_error` / `turn_end` / `turn_error` /
`early_close` / `finished`）。UIは戻り値を待たず逐次描画する。

### 保存と書き出し（App.jsx）

- 表示中の討議のテーマは `discussionTopic`、入力欄の下書きは `topic` と**分けて持つ**。
  入力欄を書き換えても書き出しのタイトルが変わらないようにするため。
- `sessionStatus` は `idle` / `running` / `completed` / `aborted` / `interrupted`。
  `running` のまま保存されたものを復元したら `interrupted` と読み替える。
  これが無いと、中断された記録と完了した討議を見分けられない。
- 保存は400msデバウンス＋`pagehide` で同期フラッシュ（タブを閉じてもunmountは走らない）。
- **`handleStart` の破棄はバリデーション通過後に行う。** 先頭に置くと、テーマ未入力で
  開始できなかったときに前回の記録が消える。順序も
  `clearTimeout(saveTimerRef.current)` → `clearSession()` にする
  （逆だと古い状態の保存が発火してセッションが書き戻る）。

## ベンダー固有の注意点

| | 内容 |
|---|---|
| Anthropic | ブラウザ直叩きには `anthropic-dangerous-direct-browser-access: true` ヘッダが必須。systemは `cache_control: ephemeral` 付きで送る |
| OpenAI | **Chat Completions ではなく Responses API (`/v1/responses`)**。GPT-5.x系は Chat Completions で「関数ツール + 推論」を拒否する。`temperature` / `max_tokens` / `reasoning_effort` は送らない。ツール定義は平坦（`function` でネストしない）で `strict: false`、結果は `function_call_output`（`call_id` は `item.id` とは別物）。`store: false` + `include: ["reasoning.encrypted_content"]` で推論を持ち回り、非対応モデルではモデル単位に記録して機能を落として再送する |
| Gemini | スキーマは OpenAPI 3.0 サブセットへ変換必須（未知キーがあると400）。型名は大文字。`parts` はそのまま履歴へ戻す。`maxOutputTokens` は思考トークンも消費するため最低8192を確保する |

## 変更時に注意すること

- **UIとログのメッセージは日本語**。エラー文言も利用者向けに日本語で書く。
- アダプタを変更したら `test/adapters.test.js` で「実際に送信されるリクエストボディ」を
  検証する。テストは `fetch` をスタブして body を捕まえる方式。
- 討議ループを変更したら `test/engine.test.js` の偽プロバイダ注入
  （`resolveProvider` 差し替え）で進行順・早期終了・中断・部分失敗を確認する。
  偽registryも実物と同じく `{ content, dataset }` へ正規化してある。
- 永続化を変更したら `test/storage.test.js`。localStorageはMapベースのスタブを
  `globalThis.localStorage` へ差し込む。`session.js` は書き込み不能を検知すると
  モジュールスコープのフラグを立てるので、テスト間で `resetStorageAvailability()` を呼ぶ。
- 外部ホストを追加する場合は `vite.config.js` の `CONNECT_SRC` を更新しないと
  本番ビルドでCSPに弾かれる。
- 既定モデルID（`claude-opus-4-6` / `gpt-5.6-terra` / `gemini-3.6-flash`）は
  実キーでの疎通が未確認。README「未検証の項目」を参照。
