# build-api-throttle-repro

Next.js のビルド時に API 同時接続数が急増する現象を再現し、セマフォや undici の接続数制限がどこまで効くかを観測する最小実験です。

## 先に結論

- セマフォ OFF だと、ビルド中に API への同時接続が膨らみ、`MAX_INFLIGHT` を超えると 503 で落ちます。
- セマフォ ON だと、各ワーカー内の実接続数だけを抑えられます。ワーカー間では共有されません。
- `undici.setGlobalDispatcher(new Agent({ connections: N }))` でも、実効としては `connections × ワーカー数` で API 側のピークを抑えられます。
- Next.js の設定層は、1段階目の一覧取得よりも2段階目のページ生成側に効く、という挙動を切り分けて観測できます。

## 最短で再現する

### 1. API サーバーを起動する

API 側で同時30件を超えたら 503 を返す設定です。

```sh
cd api
COMPANIES=12 PRODUCTS_PER_COMPANY=10 MAX_INFLIGHT=30 node server.js
```

### 2. セマフォ OFF でビルドする

503 によるビルド失敗を再現します。

```sh
cd app
npm install
rm -rf .next out
COMPANIES=12 PRODUCTS_PER_COMPANY=10 \
API_URL=http://localhost:3001 \
SEMAPHORE_LIMIT=0 \
npm run build
```

### 3. セマフォ ON でビルドする

同時接続を抑えてビルド成功を確認します。

```sh
rm -rf .next out
SEMAPHORE_LIMIT=5 npm run build
```

補足:

- 同時接続だけ観察したいなら、API 側で `MAX_INFLIGHT` を外します。既定値は `0` です。
- 各ビルド前に `rm -rf .next out` を実行してください。Next.js 16 では静的プリレンダー時のビルドキャッシュが再利用され、同一 URL の再取得が API に届かないことがあります。

## このリポジトリの構成

- `api/server.js`: 依存ゼロの Node.js HTTP サーバー。人為遅延、接続数カウンタ、ピーク値ログを持ちます。
- `app/`: Next.js 16 App Router プロジェクト。SSG と `output: 'export'` を使います。
- `app/app/products/[id]/page.tsx`: 動的セグメントを持つ商品詳細ページです。
- `app/lib/api-client.ts`: fetch ラッパーです。セマフォ ON/OFF と demand を計測します。
- `app/lib/semaphore.ts`: FIFO セマフォ実装です。
- `run-experiments.sh`: 設定違いの実験を連続実行します。
- `experiment-logs/`: 実験結果の JSON と TSV を保存します。

## 環境変数

### API 側

対象は `api/server.js` です。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `PORT` | 3001 | ポート |
| `RESPONSE_DELAY_MS` | 100 | 応答遅延(ms) |
| `COMPANIES` | 5 | `/api/companies` が返す件数 |
| `PRODUCTS_PER_COMPANY` | 5 | 1社あたりの商品件数 |
| `MAX_INFLIGHT` | `0` | 同時処理中リクエストの上限。`0` は無制限、`>0` は超過分を即 503 で返します |

### App 側

ビルド時に参照します。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `API_URL` | `http://localhost:3001` | API ベース URL |
| `SEMAPHORE_LIMIT` | `0` | `0` でセマフォ OFF、`>0` で同時実行数を制限 |
| `UNDICI_LIMIT_PER_WORKER` | `0` | `>0` で `api-client.ts` 初期化時に `setGlobalDispatcher(new Agent({ connections: N }))` を実行 |
| `UNDICI_LIMIT` | `1` | `--require ./preload-dispatcher.js` で起動したときの `connections` 値 |
| `CONFIG_VARIANT` | `baseline` | `next.config.ts` の `experimental` 切り替え。`baseline`、`cpus1`、`maxConc1`、`minPages999`、`combo` を使用 |

## undici の接続数制限を検証する

`fetch` の内部で使われる undici のグローバルディスパッチャを、2つの経路で設定して挙動を比べます。

### Setup A: 親プロセスの `--require` で preload する

```sh
rm -rf .next out
COMPANIES=12 PRODUCTS_PER_COMPANY=10 \
  SEMAPHORE_LIMIT=0 \
  UNDICI_LIMIT=1 \
  API_URL=http://localhost:3001 \
  node --require ./preload-dispatcher.js ./node_modules/.bin/next build
```

ビルドログに `[PRELOAD pid=...]` が親プロセスと各ワーカーで出ます。Next.js が親の `process.execArgv` を解析し、ワーカー起動時の `execArgv` や `NODE_OPTIONS` に転送するためです。

### Setup B: `api-client.ts` のモジュール初期化で設定する

```sh
rm -rf .next out
COMPANIES=12 PRODUCTS_PER_COMPANY=10 \
  SEMAPHORE_LIMIT=0 \
  UNDICI_LIMIT_PER_WORKER=1 \
  API_URL=http://localhost:3001 \
  npm run build
```

ビルドログに `[API-CLIENT pid=...]` が各ワーカーで出ます。各ワーカーが `api-client` を import するときに、モジュール初期化コードが走るためです。

### 共通の観測結果

ワーカー数5、`connections=1` のときは、Setup A と B のどちらでも次の結果になりました。

```text
[FINAL] {
  "peak": 5,
  "totalRequests": 133,
  "rejected503": 0
}
```

`connections × ワーカー数 = 1 × 5 = 5` で API 側の peak が頭打ちになります。`MAX_INFLIGHT=30` に届かないため、ビルドは成功します。自前セマフォと同じ範囲を抑える効果が出ている、という実測です。

## Next.js 設定がどこに効くかを再実験する

目的は、Next.js の設定層が次のどちらに効くかを切り分けることです。

- 1段階目: `generateStaticParams` 内の `Promise.all` による一覧取得
- 2段階目: 各ページ生成時の商品詳細取得

`run-experiments.sh` は、`baseline`、`cpus1`、`maxConc1`、`minPages999`、`combo` の5パターンを順に流し、`peakList` と `peakDetail` を分けて記録します。

```sh
bash run-experiments.sh
```

出力先:

- `experiment-logs/result-<variant>.json`
- `experiment-logs/results.tsv`

ビルド時間は、Next.js の `Generating static pages ... in XXXms` ログを別途見ます。

期待される観察:

- `peakList` は全 variant で12に張り付きます。これは `COMPANIES=12` 由来で、設定層が1段階目には効いていないことを示します。
- `peakDetail` は variant に応じて変わります。たとえば `maxConc1` なら5、`combo` なら1です。

## ログの見方

ビルド中とビルド後に、2種類のログを見ます。両者は数えている対象が違います。

- API 側ログ: 全ワーカー合算の、実際に受けた同時リクエスト数
- App 側ログ: 各ワーカー内で、fetch 呼び出しがどれだけ積み上がったか

### API 側ログ

ビルド完了後に API サーバーを停止すると、最後に次のような行が出ます。

```text
[FINAL] {
  "peak": 30,
  "peakList": 12,
  "peakDetail": 30,
  "totalRequests": 45,
  "rejected503": 2
}
```

各フィールドの意味:

- `peak`: 全エンドポイント合算の同時処理中リクエスト最大値です。受け付け時に `+1`、応答送信で `-1` する単純なカウンタです。
- `peakList`: `/api/companies/{id}/products` に絞った同時処理中リクエスト最大値です。1段階目の一覧取得を見ます。
- `peakDetail`: `/api/products/{id}` に絞った同時処理中リクエスト最大値です。2段階目の詳細取得を見ます。
- `totalRequests`: ビルド全体で受けた総リクエスト数です。503 で即返した分も含みます。
- `rejected503`: `MAX_INFLIGHT` 超過で 503 を返した件数です。`>0` ならパンクしています。

`peakList` と `peakDetail` を分けている理由は、設定が1段階目と2段階目のどちらを絞ったかを直接見分けるためです。`peak` だけでは、大きい方に引っ張られて区別できません。

### App 側ログ

`npm run build` の出力中には、ワーカーごとに demand peak の更新が出ます。

```text
[CLIENT pid=12345] demand peak=42 sem=OFF path=/api/products/company-3-product-7
[CLIENT pid=12345] demand peak=43 sem=OFF path=/api/products/company-3-product-8
[CLIENT pid=12678] demand peak=39 sem=OFF path=/api/products/company-5-product-2
```

セマフォ ON だと、`sem` は次のような JSON になります。

```text
[CLIENT pid=12345] demand peak=42 sem={"active":20,"peak":20,"waiting":22} path=...
```

各フィールドの意味は、[app/lib/api-client.ts](app/lib/api-client.ts#L11-L19) と [app/lib/semaphore.ts](app/lib/semaphore.ts#L29-L31) に対応しています。

- `pid`: ビルドワーカーのプロセス ID です。複数見えれば、複数ワーカーが動いています。
- `demand`: その瞬間に fetch を呼び出している最中の数です。セマフォ待ちの呼び出しも含みます。
- `demand peak`: そのワーカーで観測した demand の最大値です。更新時だけ出るので、各 `pid` の最後の行が最終ピークです。
- `sem.active`: セマフォを取得して、実際に fetch を流している数です。`limit` を超えません。
- `sem.peak`: `active` の最大値です。常に `limit` 以下です。
- `sem.waiting`: acquire 待ちの数です。大きいほど、呼び出し後に待たされた fetch が多い状態です。

## 解釈の指針

1. セマフォ OFF かつ `MAX_INFLIGHT=30` では、同時接続が30で頭打ちになり、超えた分は 503 になります。`api-client.ts` は非2xxで throw するため、ビルドは `Error: fetch ... failed: 503` で落ちます。
2. セマフォ ON かつ `SEMAPHORE_LIMIT=5` では、API 側 `peak` はおおむね `ワーカー数 × 5` で頭打ちになります。`MAX_INFLIGHT` を踏まないので、503 が出ずビルド成功になります。
3. セマフォ ON でも、ワーカー単位の `demand peak` は `sem.peak` より大きくなり得ます。理由は、fetch を呼んだあと acquire 待ちで止まっている呼び出しも demand に含まれるからです。つまり、接続数と関数呼び出しの concurrency は別物で、セマフォは前者だけを抑えます。

## 既知の前提と限界

- ビルドワーカー数は Next.js の `experimental.cpus` と `staticGenerationMinPagesPerWorker` の両方で決まります。商品数が25未満だと、1ワーカーしか立たない可能性があります。
- セマフォはモジュールスコープなので、ワーカープロセスごとに独立です。ワーカー間では共有されません。
- `output: 'export'` で全静的化しています。`'use cache'` は使っていません。キャッシュの影響を切り離して同時接続だけを観察するためです。