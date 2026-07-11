# AGENTS.md — 家計簿ツール群 引き継ぎ資料

このリポジトリを引き継ぐAIエージェント（Codex等）向けの案内。**このリポジトリは公開（GitHub Pages）です。秘密情報は絶対にコミットしないこと。**

---

## 0. 最初に読む要点（TL;DR）

- **1つの統合単一HTMLアプリ**（依存なし・localStorageのみ）＋**1つの共用 Google Apps Script**（Gemini API 無料枠を利用）。旧 `pantry/` は統合版 root へリダイレクト。
- **クライアント（HTML）は `git push` で GitHub Pages に即公開**。**サーバー（Code.gs）は clasp でデプロイ**（手順は §4）。
- **秘密情報（TOKEN / GEMINI_API_KEY / /exec URL / Pro解放コード）はリポジトリに無い。** git上の `apps-script/Code.gs` は `CHANGE_ME` プレースホルダ。実値はユーザー（菱沼さん）から受け取る。
- **無料・追加課金なし・クレカ不要**が絶対制約。AIコストはユーザー自身のGemini無料枠（BYOキー）で賄う設計。
- 変更したら**必ずテスト**（§8）。特にサーバーは**デプロイ後にワーキングツリーの秘密値を復元**（`git checkout`）すること。

---

## 1. これは何か

一人暮らしのユーザーが、**食費（1日1500円支給）の家計簿**と、**食材の賞味期限管理＋AI料理提案**を無料で回すための自作統合アプリ。iPhoneのSafariで「ホーム画面に追加」して使う。

- 💰 **家計簿タブ**（`index.html`）… 金額＋メモ追加、今日/日別/週別/月別の収支表示。カード利用通知メール→Apps Script 経由でほぼ自動同期。CSV取り込みもあり。
- 🧺 **在庫/買い物/料理タブ**（同じ `index.html`）… 賞味期限管理・品切れ→買い物リスト・レシート撮影で在庫＋食費を同時記録・AI料理提案（詳細手順／絞り込み）・期限通知。

---

## 2. アーキテクチャ

```
GitHub Pages (公開・同一オリジン)
  https://hishisyu354-commits.github.io/kakeibo/           -> index.html
        |  localStorage: "foodBudget.v1"（家計簿） + "pantry.v1"（食材）
  https://hishisyu354-commits.github.io/kakeibo/pantry/     -> 統合版 root へリダイレクト
        |
        |  fetch POST (Content-Type: text/plain;charset=utf-8 で CORS プリフライト回避)
        v
Google Apps Script（1プロジェクト共用・apps-script/Code.gs）
  doGet  … 家計簿の同期（Gmailの利用通知メール→JSONP で返す）
  doPost … 食材ストッカーの各アクション:
           ai(写真→食材名/期限) / receipt(レシート→店名/日付/合計/品目) /
           recipes(在庫→提案) / recipe(詳細手順) / pantry(在庫スナップショット保存) / ping
        |  認証は URL の ?token=... を CONFIG.TOKEN と照合
        v
Gemini API 無料枠（generativelanguage.googleapis.com, model=gemini-2.5-flash）
  APIキーは Code.gs 内 CONFIG.GEMINI_API_KEY のみ。公開HTMLには絶対に置かない。
```

- **統合設定の Apps Script URL を共用**（AI/レシート/期限通知/カード同期に同じ `.../exec?token=...` を使う）。
- **オフライン動作**・外部送信は「カード同期」と「写真/レシート/提案（Geminiへ）」のみ。

---

## 3. リポジトリ構成

```
index.html              統合アプリ（家計簿 + 食材ストッカー + 料理提案）
pantry/index.html       旧URL互換のリダイレクトページ
apps-script/
  Code.gs               共用サーバー（git上は CONFIG が CHANGE_ME プレースホルダ）
  appsscript.json       webapp: executeAs=USER_DEPLOYING, access=ANYONE_ANONYMOUS, TZ=Asia/Tokyo
  SETUP.md              ユーザー向けの手動セットアップ手順（Apps Script/Gemini/デプロイ）
  .claspignore          **/*.md をpush対象外に
.gitignore              .clasp.json / .clasprc.json / node_modules 等（認証・設定はコミットしない）
AGENTS.md               この資料
```

git管理外（ユーザーのマシンにのみ存在）:
- `.clasp.json` … `{"scriptId":"...","rootDir":"apps-script"}`（**scriptId はここ**。無ければユーザーに聞く）
- `~/.clasprc.json` … clasp のGoogle認証

---

## 4. デプロイ

### 4-1. クライアント（HTML）= GitHub Pages
`index.html` / `pantry/index.html` を編集 → コミット → `git push origin main` だけ。1〜2分でPagesに反映。
（過去にGitHub側の一時失敗で404になったことあり。その時は空コミットで再トリガー。）

### 4-2. サーバー（Code.gs）= clasp（秘密を漏らさない手順）

**重要な設計**: git の `Code.gs` は `CONFIG.TOKEN='CHANGE_ME...'` 等のプレースホルダ。実キーは**コミットしない**。デプロイ時だけ実値を差し込んで push し、直後にワーキングツリーを戻す。

環境（このマシン固有）:
```bash
export PATH="$HOME/.local/bin:$HOME/.hermes/node/bin:$PATH"   # clasp/node は ~/.hermes/node/bin, gh は ~/.local/bin
clasp --version   # v3.x
```

手順（**推奨＝「現行デプロイ済みコードに自分の変更だけ当てる」方式**。CONFIGが実値のまま維持され最も安全）:
```bash
# (0) 認証が切れていたら（invalid_rapt が出る）ユーザーに実行してもらう:  ! clasp login
clasp list-deployments        # 対象は @HEAD ではなく長いID（/exec URL に紐づく版付き）の方

# (1) 現行デプロイ済みコード（実CONFIG入り）を temp に取得
rm -rf /tmp/kk && mkdir -p /tmp/kk
printf '{"scriptId":"<.clasp.jsonのscriptId>","rootDir":"/tmp/kk"}' > /tmp/kk/.clasp.json
(cd /tmp/kk && clasp pull)     # /tmp/kk/Code.js = 実CONFIG入りの現行コード

# (2) /tmp/kk/Code.js に「自分の変更」を当てて apps-script/Code.gs に書き出す
#     （= CONFIG は現行のまま・ロジックだけ更新。secretsを一切パースせず安全）
#     node スクリプトで文字列置換（各置換は「ちょうど1件マッチ」を assert する）。secretsは絶対にprintしない。

# (3) push & redeploy（URLは変わらない）
clasp push -f
clasp redeploy <deploymentId> -d "変更内容の説明"

# (4) ワーキングツリーを復元（実キーをコミットしないため必須）
git checkout apps-script/Code.gs apps-script/appsscript.json

# (5) 検証（実キーが残っていないこと）
git grep -nI "CHANGE_ME" apps-script/Code.gs   # プレースホルダに戻っていればOK
```

代替: `PropertiesService`（スクリプトプロパティ）に秘密を入れておけば Code.gs 冒頭のIIFEが実行時に上書きするので、CONFIGが `CHANGE_ME` のままでも動く場合がある。ただし設定済みか不明なので、上記の「現行CONFIG維持」が確実。

**curlでのエンドポイント検証の罠**: `-X POST` を使うと302リダイレクト後もPOSTし続けて壊れる。必ず `-L --data-binary` で（`-X POST` を付けない）:
```bash
curl -sS -L "<exec URL>?token=<TOKEN>" \
  -H 'Content-Type: text/plain;charset=utf-8' --data-binary '{"action":"ping"}'
# 期待: {"ok":true,"gemini":true}
```

---

## 5. 秘密情報とセキュリティモデル

**リポジトリに入れてはいけない / git上に無いもの（ユーザーから受け取る）:**
- `CONFIG.TOKEN`（URL `?token=` の共有鍵）
- `CONFIG.GEMINI_API_KEY`（Gemini APIキー）
- `.../exec` のデプロイURL、deploymentId（`clasp list-deployments` で取得）
- Pro解放コードの**平文**（配布はBOOTHのDL商品経由。git上は `index.html` の `PRO_HASH`＝SHA-256のみ）
- 銀行口座番号・ネットバンキングID/パスワードは**そもそも使わない設計**（カード利用通知メールのみを読む）

原則:
- 秘密は Code.gs にだけ、公開HTMLには絶対置かない。
- git履歴にも残さない（過去に SETUP.md の例トークンが実値だった件は 9291b79 で置換済み。**TOKENのユニーク値へのローテーションは未実施＝推奨TODO**）。
- バックアップ書き出しに `apiUrl` / `syncUrl`（token付きURL）を含めない。インポート時は取り込んだURLを破棄し自端末の値を維持（悪意あるバックアップ対策）。写真はGeminiへ送るのでSETUP.mdで「食品以外を写さない」と案内済み。

---

## 6. 機能一覧（どこにあるか）

### 統合アプリ（index.html）
- 収支計算（今日/日別/週別/月別、週は月曜始まり、1500円/日の起算日 DEFAULT_START=2026-07-01）。未来分は支給に含めない。
- カード明細CSV取り込み（Shift-JIS/UTF-8自動判別・列自動判別・食費自動チェック・重複/返金除外）。
- カード利用通知メール自動同期（手入力/レシート分と date+amount で照合して二重計上を避ける）。
- 在庫（賞味/消費期限・期限が近い順ソート `sortStock`・期限チップ色分け）。品切れ→買い物リスト（`markOut`/`restockSheet`）。
- **写真で追加**（`ai`）・**レシートで追加**（`receipt`）＝在庫(`pantry.v1`)＋食費家計簿(`foodBudget.v1`)に同時記録・**各在庫行の📷で期限だけ後から追加**（`scanExp`）。
- **AI料理提案**（`recipes`）… いつ食べる(朝/昼/夜/おやつ/夜食)×ジャンル絞り込み、**賞味期限が近い食材を優先**（在庫を期限順に並べ残り日数タグを付けて送信＋サーバープロンプトで指示）、**「メニューに含める食材」で在庫から絞り込み**（`state.cookPick`、チップ選択、未選択なら在庫全体）。
- **料理をタップで詳細手順**（`recipe`＝材料/番号手順/コツをオンデマンド生成、`detailCache`/`recipesGen`/`sheetGen` で非同期安全）。
- 期限通知（アプリ内＋Apps Scriptの `setupNotifyTrigger` で毎朝メール／在庫スナップショットは変更のたびPOST保存）。
- **収益化の実験（§9）**: 買い物リストの各品目に楽天「🛒 探す」リンク／Pro版（テーマ）。

---

## 7. データモデルと堅牢化パターン

- 家計簿エントリ: `{id,date,amount,memo,ts,[src]}`。`sanitize()` が不正日付・未来日付・amount<=0 を除外。`src`=カード同期の重複排除ID。
- ストッカー state（`pantry.v1`）: `{items[], apiUrl, notifyDays, lastRecipes, cookFilter{meal,genre}, affId, affClicks, pro, theme, cookPick[]}`。各 item: `{id,name,expiry|null,kind:'賞味期限'|'消費期限'|null,state:'stock'|'out',addedAt,outAt}`。
- **`sanitize()` はホワイトリスト方式**（load時とインポート時に通す）。フィールドを追加したら **3箇所のデフォルトリテラル**（load fallback / sanitize out / reset）と **sanitizeのバリデーション**を必ず揃える。値は型・範囲・列挙をチェックしてから採用。
- **非同期の取り違え防止**: シートは `openSheet` が `dataset.gen` を発番（`sheetGen`）。提案の世代は `recipesGen`。古い応答が新しいUIに書き込まないよう、書き込み前に世代一致を確認する。

---

## 8. テスト（変更後は必須）

このプロジェクトにテストランナーは無い。**Node で該当関数のソースを文字列抽出して素の関数として実行**するのが定石（DOM非依存の純ロジックのみ抽出。`el`/DOMに触れる関数は避け、`sanitize`/`sanitizeBudget`/`daysLeft`/`sortStock`/`rakutenUrl`/`applyTheme` 等を検証）。パースチェックは:
```bash
node -e 'const fs=require("fs");const c=fs.readFileSync("index.html","utf8").match(/<script>([\s\S]*)<\/script>/)[1];new Function(c);console.log("parses OK")'
```
UIの見た目は**ヘッドレスChromeでスクショ**（localStorageをseedするHTMLを一時生成→`--screenshot`）。例はコミット履歴・過去のscratchpad参照。ダーク/オーシャンのテーマ差はCSS変数 `:root[data-theme=...]` で切替。

Chrome: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --screenshot=... --window-size=430,932 file://...`

---

## 9. 収益化の方針（相談で確定した前提）

「**AIは無料のまま（ユーザー自身のGemini無料枠＝COGSゼロ）**」を大前提に:
1. **楽天アフィリエイト実験**: 買い物リストの各品目に `rakutenUrl()` で「🛒 探す」。設定で `affId` を入れると成果計測リンクで包む。未入力でも通常検索で動く。タップ数を `state.affClicks` で計測。
2. **Pro版 買い切り¥300（BOOTH配布）**: 解放コード→SHA-256照合（`PRO_HASH`）→`state.pro=true`。解放できるのは**テーマ（ダーク/オーシャン）のみ**。AI・在庫・家計簿は無料で全機能。データを人質にしない方針。買い切り×AIはCOGS再発で赤字化するため課金対象はコスメ(テーマ)に限定、と整理済み。

---

## 10. 未完了 / TODO（引き継ぎ事項）

- [ ] **BOOTH出品URL**をユーザーからもらい `index.html` の `BOOTH_URL` を実URLに差し替え（現在は `https://booth.pm/` 仮）。DL商品にPro解放コードを同梱。
- [ ] **楽天アフィリエイトID**をユーザーが登録したら設定タブに入力（コード変更不要）。
- [ ] **parseMail の正規表現を実物メールで確定**（`apps-script/Code.gs`）。対象は三菱UFJ-VISAデビットの利用通知（差出人 `mail@debit.bk.mufg.jp`／件名「【三菱UFJ-VISAデビット】ご利用のお知らせ」、`GMAIL_QUERY` はUFJ用に設定済み）。実物メール本文をもらってから金額/日付/店名の抽出を合わせる。
- [ ] **TOKENのユニーク値へのローテーション推奨**（変えたら両アプリの `?token=` を更新）。
- 直近デプロイ済み（参考）: Apps Script はAI呼び出しの自動リトライ（429/500/503/529）＋料理提案の期限優先プロンプトを反映済み。

---

## 11. 守るべき制約・原則

- **完全無料・広告なし・追加課金なし・クレジットカード登録不要**。AIはGemini無料枠（BYOキー）。
- **iPhone（Safari→ホーム画面）中心**。単一HTML・依存なし・オフライン優先。
- **プライバシー**: データは端末localStorageのみ。外部送信はカード同期とGemini（写真/提案）だけ。口座番号・netバンキング資格情報は扱わない。
- **秘密をコミットしない**（§5）。サーバーデプロイ後は必ずワーキングツリー復元。
- コードは既存のスタイル（日本語コメント密度・命名・関数分割）に合わせる。単一HTMLの1ファイル完結を崩さない。
