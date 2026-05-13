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
- `app/preload-dispatcher.js`: `node --require` で先読みする undici グローバルディスパッチャの初期化スクリプトです。
- `run-experiments.sh`: 設定違いの実験を連続実行します。
- `experiment-logs/`: 実験結果の JSON と TSV を保存します。
- `api/server-db.js`、`api/init.sql`、`api/package.json`、`docker-compose.yml`、`run-experiments-db.sh`: 裏側に PostgreSQL を置いた版の実験用です。

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

各フィールドの意味は、[app/lib/api-client.ts](app/lib/api-client.ts#L17-L28) と [app/lib/semaphore.ts](app/lib/semaphore.ts#L31-L33) に対応しています。

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

## 裏側に DB を置いて検証する

### なぜ DB を置くのか

ここまでの `api/server.js` は、`setTimeout` で遅延を作って、`MAX_INFLIGHT` を超えたら自分で 503 を返していました。これは「API がどこかに上限を持っている」という状態の合成です。

実際のシステムでは、API の裏側に DB があり、その間に **プール** (接続を使い回す貯金箱) が居ます。同時アクセスが増えたとき、最初に詰まるのは API そのものではなく、たいていこのプールか、その先の DB です。

この節では、API と DB の間に PostgreSQL を実際に置いて、次の2種類の詰まりを別々に観測します。

1. プールの**枯渇**: pg の `Pool` が貸せる接続を全部使い切り、次の `connect()` が待ち行列に並ばされる状態
2. DB 側の**同時接続上限超過**: Postgres の `max_connections` を超えた接続要求が、DB 自体に拒否される状態

### 全体像

リクエストが流れる経路と、各層の上限を並べると次のようになります。

```
[Next.js ワーカー] -- HTTP --> [API: server-db.js] -- pg.Pool --> [Postgres]
       ↑                              ↑                  ↑              ↑
 SEMAPHORE_LIMIT             (常に1接続を借りる)     DB_POOL_MAX   max_connections
  UNDICI_LIMIT
```

各層に「同時に通れる本数の上限」があり、**一番狭いところ**で詰まります。アプリ側のセマフォはここでの一番上の層で、DB 側の `max_connections` は一番下の層です。アプリ側で抑えても下流で詰まりうる、逆に下流が広くてもアプリ側で詰まる、というのがこの実験で見えるはずです。

### 用語

#### 接続 (connection)

アプリと DB の間に張る専用の通信路です。1つのリクエストを処理している間、API はこれを1本握り続けます (`server-db.js` がそうなっています)。

#### プール (pg.Pool)

接続を使い回すための、**API 側の貯金箱**です。リクエストが来るたびに新規接続を作ると遅いので、貸し出し→返却→再利用できる仕組みです。

#### `DB_POOL_MAX` と `max_connections` の違い

接続数の上限は **2か所** に存在します。名前が似ていて紛らわしいので、ここで並べて整理します。

| 名前 | 場所 | 意味 | 超えるとどうなるか |
|---|---|---|---|
| `DB_POOL_MAX` | **API 側** (アプリ側) | プールが**同時に貸せる接続の最大数**。アプリ側が決める | 新しいリクエストは「誰かが接続を返すまで」プール内で待たされる |
| `max_connections` | **DB 側** (Postgres 側) | DB が**同時に受け付けられる接続の総数**。DB 側が決める | DB に接続要求が届いた時点で拒否される (`FATAL: sorry, too many clients already`) |

実効上限は**両者の小さい方**で決まります。

- 例 1: `DB_POOL_MAX=5`, `max_connections=100` → 実効5。プールが先に詰まる (= プール枯渇)
- 例 2: `DB_POOL_MAX=30`, `max_connections=15` → 実効15。プールはまだ余裕があるのに、DB 側で蹴られる

シナリオ `db-noLimit` / `db-sem2` は前者、`db-pgMax15` は後者です。

#### プール枯渇

プールから接続を借りようとしたら、貸せる接続が0で、誰かが返すまで待たされる状態のことです。`DB_POOL_MAX` を小さくすると起きやすくなります。

#### acquire-time (取得待ち時間)

`pool.connect()` を呼んでから、実際に接続が手に入るまでの時間です。プールに余裕があればほぼ0ms、枯渇していれば数百msから秒単位まで伸びます。

#### `pg_sleep`

Postgres にその秒数だけ「何もせず接続を握り続ける」ように頼む関数です。`server-db.js` は応答遅延の代わりにこれを呼ぶので、接続も握り続けます。これで「リクエスト処理中ずっと接続が占有される」現実的な状況を再現しています。

### 構成ファイル

- [docker-compose.yml](docker-compose.yml): Postgres 16を5432で起動。`PG_MAX_CONNECTIONS` で `max_connections` を切り替えられます
- [api/init.sql](api/init.sql): `companies` と `products` のテーブル定義
- [api/server-db.js](api/server-db.js): `pg.Pool` 経由で問い合わせる API
- [api/package.json](api/package.json): `pg` 依存
- [run-experiments-db.sh](run-experiments-db.sh): 3シナリオを連続実行

### 起動

初回だけ依存をインストールします。

```sh
docker compose up -d
cd api && npm install
```

### 環境変数 (DB 版)

`api/server-db.js` は次の変数を見ます。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `PG_HOST` `PG_PORT` `PG_USER` `PG_PASSWORD` `PG_DATABASE` | localhost / 5432 / postgres / postgres / throttle | 接続先 |
| `DB_POOL_MAX` | 10 | pg の `Pool` が同時に貸せる接続の上限 |
| `DB_POOL_TIMEOUT_MS` | 5000 | プール待ちでこの時間を超えると `pool.connect()` が reject |
| `RESPONSE_DELAY_MS` | 100 | `pg_sleep` で接続を握ったまま待つ時間 |

Postgres 側の `max_connections` を変えるときは、`docker-compose.yml` の `PG_MAX_CONNECTIONS` を渡して `docker compose up -d --force-recreate postgres` で再起動します。

### 計測される指標

`server-db.js` の `[FINAL]` ログには次が出ます。シミュレーション版に**プール待ち**と**DB 接続エラー**が増えています。

- `peak`、`peakList`、`peakDetail`、`totalRequests`: シミュレーション版と同じ
- `rejected503`: プール待ちタイムアウトまたは DB 接続エラーで 503 を返した件数
- `poolTimeouts`: `DB_POOL_TIMEOUT_MS` 超過の件数
- `dbConnectErrors`: Postgres から「too many clients」などで接続を拒否された件数
- `poolWait.{avgMs, p50Ms, p95Ms, p99Ms, maxMs}`: acquire-time の分布

### 実験する

```sh
bash run-experiments-db.sh
```

3つのシナリオを順番に走らせ、`experiment-logs/results-db.tsv` に結果を書きます。3つはそれぞれ別の角度から「どこで詰まるか」を見せます。

| scenario | sem | poolMax | pgMax | 何を見るか |
|---|---|---|---|---|
| `db-noLimit` | 0 | 5 | 100 | DB は余裕あり、プールだけ狭い → プール待ち時間 |
| `db-sem2` | 2 | 5 | 100 | アプリ側で抑えるとプール待ちがどれだけ減るか |
| `db-pgMax15` | 0 | 30 | 15 | プールは広いが DB 自体が狭い → どこでエラーが出るか |

### 実測結果

`COMPANIES=12 PRODUCTS_PER_COMPANY=10 RESPONSE_DELAY_MS=100` での結果です。

| scenario | peakAll | rejected503 | dbConnectErrors | waitAvg | waitP95 | waitMax | buildOk |
|---|---|---|---|---|---|---|---|
| `db-noLimit` | 5 | 0 | 0 | 453ms | 715ms | 725ms | yes |
| `db-sem2` | 5 | 0 | 0 | 68ms | 105ms | 138ms | yes |
| `db-pgMax15` | 15 | 17 | 17 | 7ms | 21ms | 22ms | no |

#### `db-noLimit`: プールが詰まるとどう見えるか

`peakAll=5` は、API が同時並行で処理できたリクエスト数の最大値です。`DB_POOL_MAX=5` なので、6件目以降は接続を借りるところで待たされます。

`MAX_INFLIGHT` のような即時の拒否はありません。ビルドはちゃんと完走しますが、`waitMax=725ms` のとおり、接続待ちで秒未満のラグが積み上がります。`rejected503=0` でもビルドが遅い、というケースの見え方です。

#### `db-sem2`: アプリ側で抑えると待ちが減る

アプリ側の `SEMAPHORE_LIMIT=2` で、各ワーカーからの fetch 同時実行数を抑えました。

API 側の `peakAll=5` は変わりません (プール幅5のまま)。ただしプールへの殺到が減るので、`waitAvg` が `453ms → 68ms` に下がります。「アプリ側のセマフォは、API のすぐ裏にあるプールの圧力にも効く」という関係を、数字で確認できる場所です。

#### `db-pgMax15`: DB 自体が狭いとどう失敗するか

このシナリオは **Postgres 側の `max_connections=15` のほうが、API 側のプール幅 `DB_POOL_MAX=30` より狭い** という構図です。プールは「30本まで開ける気でいる」のに、DB は「15本までしか受け付けない」という状態を作っています。

ビルドが殺到すると、API は Postgres に16本目以降の接続を開こうとします。Postgres はそれを `FATAL: sorry, too many clients already` で拒否します。`server-db.js` はそのエラーを 503 として返すので、ビルドは `fetch ... failed: 503` で落ちます。

実測値の意味は次のとおりです。

- `peakAll=15`: 同時に成立した接続数が15で頭打ち。`max_connections=15` をそのまま使い切っています
- `dbConnectErrors=17`: 16本目以降の接続要求が DB に拒否された件数
- `rejected503=17`: それを 503 として返した件数 (= `dbConnectErrors` と一致)

`docker logs throttle-postgres` を見ると、`FATAL: sorry, too many clients already` が17回ぶん並んでいるのが確認できます。

補足: Postgres には `superuser_reserved_connections` (既定3) という、スーパーユーザー専用に予約される接続枠があります。一般ユーザーで接続する場合の実効上限は `max_connections - superuser_reserved_connections = 12` になります。今回の API は `postgres` ユーザー (スーパーユーザー) でつないでいるので、予約枠3も含めてフルの15本を使えており、`peakAll=15` になっています。

### この実験から読み取れること

- API 側 `peak` は、アプリのセマフォ／undici 上限だけでなく、**裏側で一番狭い層**で頭打ちになります。プール幅で頭打ちなのか DB 上限で頭打ちなのかは、`dbConnectErrors` が出ているかで見分けがつきます
- `rejected503=0` でも `poolWait` を見る価値があります。落ちないだけで、待ち時間として遅さに転化していることがあります
- `dbConnectErrors > 0` は、アプリ側のセマフォや undici では救えません。対処は、DB の上限を上げるか、API 側のプールを **DB 上限より狭く** 設定して、自分が先に詰まる側に回って整列させるかです

### 後片付け

```sh
docker compose down -v
```

## 既知の前提と限界

- ビルドワーカー数は Next.js の `experimental.cpus` と `staticGenerationMinPagesPerWorker` の両方で決まります。商品数が25未満だと、1ワーカーしか立たない可能性があります。
- セマフォはモジュールスコープなので、ワーカープロセスごとに独立です。ワーカー間では共有されません。
- `output: 'export'` で全静的化しています。`'use cache'` は使っていません。キャッシュの影響を切り離して同時接続だけを観察するためです。