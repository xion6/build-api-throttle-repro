# build-api-throttle-repro

Next.js のビルド時に API 同時接続数が爆発する現象を再現し、セマフォによる制限の効果を計測する最小実験。

## 構成

- `api/server.js` — 依存ゼロの Node.js HTTP サーバー（人為遅延、接続数カウンタ、ピーク値ログ）
- `app/` — Next.js 16 App Router プロジェクト（SSG、`output: 'export'`）
  - `app/products/[id]/page.tsx` — 動的セグメントを持つ商品詳細ページ
  - `lib/api-client.ts` — fetch ラッパー（セマフォ ON/OFF、demand 計測）
  - `lib/semaphore.ts` — FIFO セマフォ実装

## 環境変数

### API 側（`api/server.js`）
| 変数 | 既定値 | 意味 |
|---|---|---|
| `PORT` | 3001 | ポート |
| `RESPONSE_DELAY_MS` | 100 | 応答遅延（ms） |
| `COMPANIES` | 5 | `/api/companies` が返す件数 |
| `PRODUCTS_PER_COMPANY` | 5 | 1社あたりの商品件数 |
| `MAX_INFLIGHT` | `0` | 同時処理中リクエストの上限。`0` で無制限。`>0` で超過分は `503` を即返す（パンク模擬） |

### App 側（ビルド時に参照）
| 変数 | 既定値 | 意味 |
|---|---|---|
| `API_URL` | `http://localhost:3001` | API ベース URL |
| `SEMAPHORE_LIMIT` | `0` | `0` でセマフォ OFF。`>0` で同時実行を制限 |

## 実行手順

ターミナル1 — API サーバー起動（`MAX_INFLIGHT=30` で同時30件超過は503を返す）:
```sh
cd api
COMPANIES=12 PRODUCTS_PER_COMPANY=10 MAX_INFLIGHT=30 node server.js
```

ターミナル2 — App ビルド（セマフォ OFF → 503 でビルド失敗が再現）:
```sh
cd app
npm install
rm -rf .next out
COMPANIES=12 PRODUCTS_PER_COMPANY=10 \
SEMAPHORE_LIMIT=0 \
API_URL=http://localhost:3001 \
npm run build
```

ターミナル2 — App ビルド（セマフォ ON、上限5 → 503 が出ずビルド成功）:
```sh
rm -rf .next out
SEMAPHORE_LIMIT=5 npm run build
```

> 同時接続だけ観察したい（パンクさせない）ときは API 側で `MAX_INFLIGHT` を外す（既定の `0`）。

> **重要**: 各ビルド前に rm -rf .next out を実行する。Next.js 16のfetch既定はauto no cacheだが、静的プリレンダー時はビルドキャッシュ（.next/cache/fetch-cache）が再利用され、同一URLの再取得がAPIに届かない場合がある。

## 検証結果の見方

ビルド中・ビルド後に2種類のログが出る。両者は別の場所で別のものを数えている点に注意。

### ログ1: API 側ターミナル

ビルド完了後に API サーバーを `Ctrl+C` で止めると、最後にこの行が出る:

```
[FINAL] {
  "peak": 30,
  "totalRequests": 45,
  "rejected503": 2
}
```

- `peak` … API サーバーが受けた同時処理中リクエストの最大値。受け付けて処理開始で `+1`、応答送信で `-1` する素朴なカウンタ
- `totalRequests` … ビルド全体で受けた総リクエスト数（503 で即返したぶんも含む）
- `rejected503` … `MAX_INFLIGHT` 超過で 503 を返した件数。`>0` ならパンクが起きた証拠

ここで見る数字は「全ワーカー合計」のサーバー視点。複数のワーカーが同時に叩いていれば、その総和としてピークが立つ。

### ログ2: App 側 stdout（ビルドログ）

`npm run build` の出力中に、ワーカーごとに demand peak が更新されたタイミングで出る:

```
[CLIENT pid=12345] demand peak=42 sem=OFF path=/api/products/company-3-product-7
[CLIENT pid=12345] demand peak=43 sem=OFF path=/api/products/company-3-product-8
[CLIENT pid=12678] demand peak=39 sem=OFF path=/api/products/company-5-product-2
```

セマフォ ON のときは `sem` の中身が `{"active":N,"peak":M,"waiting":W}` になる:

```
[CLIENT pid=12345] demand peak=42 sem={"active":20,"peak":20,"waiting":22} path=...
```

各フィールドの意味（[app/lib/api-client.ts:11-19](app/lib/api-client.ts#L11-L19), [app/lib/semaphore.ts:29-31](app/lib/semaphore.ts#L29-L31)）:

- `pid` … ビルドワーカーのプロセス ID。ワーカーごとに別行が出るので、`pid` が複数見えれば複数ワーカーが走っている
- `demand` … その瞬間に「fetch を呼び出している最中」の数。セマフォ ON でも、acquire 待ちの fetch まで含めて demand に乗る点が肝。`rawFetch` 入口で `+1`、`finally` で `-1`
- `demand peak` … そのワーカーで観測した demand の最大値。更新時のみ出力されるので、各 `pid` の最後の行がそのワーカーの最終ピーク
- `sem.active` … セマフォを取得して実際に fetch を流している数。`limit` を超えない
- `sem.peak` … `active` の最大値（≤ `limit`）
- `sem.waiting` … acquire を待っている数。これが大きいほど、fetch を呼んだ後に待たされた呼び出しが多い

### 解釈の指針

1. セマフォ OFF + `MAX_INFLIGHT=30`: 同時接続が 30 で頭打ちになり、超えたぶんは 503。`api-client.ts` が非 2xx で `throw` するためビルドが `Error: fetch ... failed: 503` で落ちる。`rejected503 > 0` で観測できる
2. セマフォ ON（`SEMAPHORE_LIMIT=5`）+ `MAX_INFLIGHT=30`: API 側 `peak` が `ワーカー数 × 5 = 25` 前後で頭打ち、`MAX_INFLIGHT` を踏まないので 503 が出ずビルド成功
3. ワーカー単位の `demand peak` が `sem.peak`（=`limit`）を超える現象: セマフォ ON でも `demand peak` は `limit` より大きい値が出る。これは「fetch を呼んだが acquire 待ちで止まっている」呼び出しが demand に乗っているため。**接続数（API 側 peak）と関数呼び出しの concurrency（demand）は別物**で、セマフォは前者だけを抑える、というのが記事の主張に対応する観察

## 既知の前提・限界

- ビルドワーカー数は Next.js の `experimental.cpus`（既定 `os.cpus().length - 1`）と `staticGenerationMinPagesPerWorker`（既定25）の両方で決まる。商品数が25未満では1ワーカーしか立たない可能性
- セマフォはモジュールスコープなのでワーカープロセスごとに独立。ワーカー間で共有されない（記事の主張のとおり）
- `output: 'export'` で全静的化。`'use cache'` は使用していない（キャッシュの影響を切り離して同時接続だけを観察する目的）

## ライセンス

MIT
