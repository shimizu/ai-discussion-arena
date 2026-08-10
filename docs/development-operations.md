# 開発・テスト・デプロイ運用

## ローカルセットアップ

必要条件はGit、npm、Vite 8が対応するNode.js（`^20.19.0 || >=22.12.0`）です。

```bash
npm install
npm run dev
```

開発サーバーは `http://localhost:3100` で起動します。外部APIを実際に使う場合、画面右上のAPI設定へ各社キーを入れます。キーはブラウザの `localStorage` に保存され、`.env` は使いません。

## npmスクリプト

| コマンド | 用途 |
|---|---|
| `npm run dev` | Vite開発サーバーをポート3100で起動 |
| `npm test` | `test/*.test.js` をNode標準テストで実行 |
| `npm run build` | 本番用 `dist/` を生成しCSP metaを注入 |
| `npm run preview` | `dist/` をポート3100で配信して確認 |
| `npm run deploy` | build後、`gh-pages` で `dist/` を公開 |

単一ファイルまたはテスト名で絞る例:

```bash
node --test test/adapters.test.js
node --test --test-name-pattern="思考署名" test/adapters.test.js
```

テストはビルドを介さず `src/` のESMを直接importします。DOMや通常のブラウザAPIはありません。`fetch` と `localStorage` は各テスト内でスタブします。

## テスト構成

| ファイル | 保証する範囲 |
|---|---|
| `adapters.test.js` | 各LLMへ送るbody、tool往復、reasoning/signature保持 |
| `discussion.test.js` | スケジュール、役割割当、Gemini schema変換 |
| `engine.test.js` | 共有資料、部分失敗、早期終了、中断、dataset境界 |
| `tools.test.js` | e-Stat / World BankのURL・整形・エラー・行上限 |
| `storage.test.js` | 保存復元、容量劣化、サニタイズ、2キー構成 |
| `export.test.js` | Markdown、CSV quote、式注入、資料番号 |

変更種別にかかわらず、引き渡し前の基本検証は次です。

```bash
npm test
npm run build
```

## 手動受け入れ確認

実キーを使える環境では、低コストのモデルと1〜2巡で次を確認します。

1. API設定でモデル一覧を取得できる。
2. 1社だけでも3役が埋まり、総括まで進む。
3. 2社・3社で役割が割り当てられ、発言が交互に表示される。
4. e-Stat IDなしではe-Statツールが選ばれない。
5. 統計を必要とするテーマで、取得資料が後続発言にも現れる。
6. 討議中に停止し、`aborted` の記録を出力できる。
7. 途中でリロードし、`interrupted` としてそこまでの記録が復元される。
8. MarkdownとCSVを出力し、資料番号と日本語・数値表示が一致する。
9. `npm run preview` でもAPI接続でき、CSP違反がブラウザconsoleに出ない。

本番キーを使った疎通は課金を伴います。既定6巡では開会・中間整理・総括も含め多数のモデル呼び出しになり、ツール往復があるとさらに増えます。

## 本番ビルドとCSP確認

```bash
npm run build
npm run preview
```

`vite.config.js` は `base: "./"` のため、サブパスやGitHub Pagesの配置階層に依存せず相対アセットを参照します。

本番ビルド後は次を確認してください。

```bash
rg -n "Content-Security-Policy|connect-src" dist/index.html
```

新しいAPIホスト、画像CDN、分析基盤などを導入するときは、コード変更だけではCSPで遮断されます。必要最小限のoriginを `CONNECT_SRC` または該当directiveへ追加し、APIキーが不要な第三者送信先へ流れないことをレビューしてください。

## デプロイ

`npm run deploy` は次を連続実行します。

```text
npm run build
└─ gh-pages -d dist -m "chore: deploy" --nojekyll
```

これはリモートの `gh-pages` ブランチを更新する外部変更です。実行前に次を確認します。

- 正しいGitリモートとリポジトリを向いている。
- `main` の変更がcommit済みで、テストとbuildが成功している。
- `dist/index.html` に期待するCSPがある。
- 配布先のGitHub Pages設定が `gh-pages` ブランチを参照している。

## 障害切り分け

### モデル一覧を取得できない

- APIキーの前後空白、失効、権限、課金状態を確認する。
- ブラウザのNetworkでHTTP statusとCORS errorを区別する。
- 開発環境では接続できるがpreviewで失敗する場合、CSPの `connect-src` を確認する。
- OpenAI一覧にはembedding、audio、image等を除外する正規表現があるため、存在する全モデルが表示されるわけではない。

### 発言だけ失敗して討議が進む

これは意図した部分失敗動作です。画面の失敗メッセージと出力議事録の「発言できなかった順番」を確認します。401ならキー、404ならモデルID、429ならquota/rate limit、空本文なら出力上限や安全フィルターを疑います。

### ツール呼び出し後に400になる

最初にadapterテストと送信bodyの仕様差を確認します。

- Anthropic: `tool_use_id` が一致しているか。
- OpenAI: `call_id` を使っているか、reasoning itemとfunction callの順序を維持したか。
- Gemini: `parts` と `thoughtSignature` を再構築で落としていないか。
- 共通: `raw` をJSON変換や独自mapで作り直していないか。

詳細は [複数AI APIの統合設計](ai-api-orchestration.md) を参照してください。

### e-Statが失敗する

- appIdが設定されているか。
- searchで得た `statsDataId` を使っているか。
- metadataで正式な分類コードを確認したか。
- 件数が多い場合、年・地域・分類を絞っているか。
- HTTP 200でもe-Stat JSON内の `RESULT.STATUS` がエラーになる場合がある。

### World Bank検索が遅い

初回はWDI指標カタログを取得するため正常です。同一ページ内の2回目以降はメモリキャッシュを使います。毎回遅い場合はページ再読み込み、ネットワーク、APIのページ数変化、CORSを確認します。

### 討議が復元されない

- 発言も資料もないセッションは意図的に復元しない。
- `SESSION_VERSION` が違うデータは読み込まない。
- localStorageが無効、容量超過、壊れたJSONの場合は安全側に倒す。
- DevToolsで `ai-discussion.session` と `ai-discussion.datasets` を分けて確認する。APIキーの値をログやissueへ貼らない。

## リリース前チェックリスト

- [ ] 変更した設計契約が `docs/` とコードコメントで一致している
- [ ] `npm test` が成功する
- [ ] `npm run build` が成功する
- [ ] `dist/index.html` のCSPを確認した
- [ ] 新しい外部originと保存データをレビューした
- [ ] APIキーや取得データをconsoleへ出していない
- [ ] 1社・複数社・中断・部分失敗を必要範囲で確認した
- [ ] Markdown / CSVの出力互換性を確認した
- [ ] 既定モデルやAPI仕様変更がある場合、実キーで最小疎通した
