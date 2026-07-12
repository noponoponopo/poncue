ポン出し用Webサウンドボードです。音声ファイルをブラウザに追加し、シーン単位で管理・再生できます。

## 主な機能

- 音声ファイルの追加と複数ファイル選択
- シーンの追加、選択、名前変更、削除
- シーンデータのインポートとエクスポート
- サウンドごとの再生、停止、ループ、音量、シーク、フェード設定
- EQ、Delay、Compressor などのエフェクト設定
- マスター音量、レベルメーター、波形表示
- クリック優先モードとドラッグ編集モードの切り替え
- グリッドと自由配置レイアウトの切り替え、シーンごとのパッド位置保存
- ダークモード、パッドサイズ変更
- PWAとしての利用とService Workerによるキャッシュ

## 技術構成

- Vite
- Bun
- Tone.js
- Web Audio API
- IndexedDB
- localStorage
- Service Worker / Web App Manifest

## データ保存

アプリのデータはブラウザ内に保存されます。

- シーンと音声ファイル: IndexedDB
- 表示設定や操作設定: localStorage / IndexedDB

IndexedDBのDB名は `ponndashiDB_v2` です。別ブラウザや別端末には自動同期されません。移行やバックアップには、アプリ内のエクスポート機能を使います。

## 音声ファイル

音声追加フォームは、主に次の形式を受け付けます。

- MP3
- WAV
- M4A / AAC
- OGG / Opus
- その他ブラウザが扱える `audio/*`

1ファイルあたりの上限は `512MB` です。

## PWAについて

本番環境ではService Workerが登録され、ローカルファイルと一部の外部リソースをキャッシュします。Viteの開発モードでは、古いキャッシュによる誤動作を避けるため、既存のService Worker登録を解除します。

`manifest.json` は次のアイコンを参照しています。

- `icons/icon-192x192.png`
- `icons/icon-512x512.png`


## 関連ドキュメント

- [`docs/audio-architecture.md`](docs/audio-architecture.md): 音声処理、レイテンシ、エフェクト構成の設計メモ
