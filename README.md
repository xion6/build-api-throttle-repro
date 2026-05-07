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

### App 側（ビルド時に参照）
| 変数 | 既定値 | 意味 |
|---|---|---|
| `API_URL` | `http://localhost:3001` | API ベース URL |
| `SEMAPHORE_LIMIT` | `0` | `0` でセマフォ OFF。`>0` で同時実行を制限 |

## 実行手順

ターミナル1 — API サーバー起動:
```sh
cd api
COMPANIES=12 PRODUCTS_PER_COMPANY=10 node server.js
```

ターミナル2 — App ビルド（セマフォ OFF）:
```sh
cd app
npm install
COMPANIES=12 PRODUCTS_PER_COMPANY=10 \
SEMAPHORE_LIMIT=0 \
API_URL=http://localhost:3001 \
npm run build
```

ターミナル2 — App ビルド（セマフォ ON、上限20）:
```sh
SEMAPHORE_LIMIT=20 npm run build
```

API 側ターミナルの `[FINAL] peak=...` がそのビルドにおける同時接続ピーク（API サーバーから見た値）。
App 側 stdout の `[CLIENT pid=... demand peak=...]` がワーカー単位のクライアント側 demand（fetch 呼び出し中の数）。

## 計測項目

1. セマフォ OFF: API 側 peak が大きく（demand と近い値）出る
2. セマフォ ON (limit=20): API 側 peak がワーカー数 × 20 程度に張り付く
3. ワーカー単位の demand peak がセマフォ active を上回る現象（記事の主張）

## 既知の前提・限界

- ビルドワーカー数は Next.js の `experimental.cpus`（既定 `os.cpus().length - 1`）と `staticGenerationMinPagesPerWorker`（既定25）の両方で決まる。商品数が25未満では1ワーカーしか立たない可能性
- セマフォはモジュールスコープなのでワーカープロセスごとに独立。ワーカー間で共有されない（記事の主張のとおり）
- `output: 'export'` で全静的化。`'use cache'` は使用していない（キャッシュの影響を切り離して同時接続だけを観察する目的）

## ライセンス

MIT
