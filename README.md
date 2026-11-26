# まちあわせ 📍

リンクを送るだけで使える待ち合わせアプリ。登録不要・依存パッケージなし（Node.js だけで動きます）。

## できること

- **まちあわせを作る** — タイトル・場所・日時・メモを入力し、地図にピンを置けます（任意）
- **リンクで共有** — スマホの共有シートか、クリップボードへのコピー
- **参加** — 名前を入れるだけで参加できます（端末に記憶されます）
- **ステータス** — 未出発 / 向かってる / もうすぐ着く / 到着 / 遅れる / 行けない
- **到着予定** — 「あと◯分」を選ぶと、到着予定時刻がみんなに表示されます
- **位置共有（任意）** — オンにすると地図に表示され、集合場所までの距離も出ます
- **チャット** — 定型文ボタン付き（「今どこ？」「着いたよ！」など）
- **カウントダウン**と、Google マップでの**経路案内**
- 更新は Server-Sent Events で全員にリアルタイム反映されます

## 公開（Render・無料）

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/ZenithExtremers/machiawase)

1. 上のボタンを押す（または https://dashboard.render.com で **New → Blueprint** を選びこのリポジトリを指定）
2. GitHub でログインし、このリポジトリへのアクセスを許可
3. **Apply** を押して数分待つと `https://machiawase-xxxx.onrender.com` のような URL ができます

無料プランの注意:
- 15分アクセスがないとスリープし、次に開くとき 30〜60 秒ほどかかります
- 再起動やスリープ復帰でディスクが初期化されるため、作った待ち合わせは消えることがあります（当日使う分には問題なし）

## 起動（ローカル）

```bash
npm start            # http://localhost:3000
PORT=8080 npm start  # ポートを変える場合
npm test             # API のテスト
```

データは `data/rooms.json` に保存され、待ち合わせ時刻の2日後に自動で削除されます（保存先は `DATA_DIR` で変更可）。

## 構成

| ファイル | 内容 |
| --- | --- |
| `server.js` | HTTP サーバー・API・リアルタイム配信・静的ファイル配信 |
| `public/index.html` | 画面（ホーム / まちあわせ画面） |
| `public/app.js` | フロントエンド |
| `public/style.css` | スタイル（ダークモード対応） |
| `test/api.test.js` | API テスト（`node --test`） |

地図は [Leaflet](https://leafletjs.com/) と OpenStreetMap を CDN から読み込みます。

## 注意

- 位置情報はスマホのブラウザで **HTTPS** のときだけ使えます（localhost は例外）。公開するときは HTTPS で配信してください。
- アカウントはありません。リンクを知っている人は誰でも閲覧・参加できます。各メンバーの更新は、その端末に保存された秘密のトークンでのみ行えます。
