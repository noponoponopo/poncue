# Audio Architecture

このアプリは、音声の安定供給と操作への応答性を最優先にする。

## Current Audio Path

高パフォーマンスモードでは、音声は事前に `AudioBuffer` へ decode される。
パッド操作時は `AudioBufferSourceNode.start()` までの処理を短く保つ。

```text
AudioBufferSourceNode
  -> individualGain
  -> EffectRack
  -> masterGain
  -> outputLimiter
  -> destination
```

`EffectRack` は `modules/09_effects.js` にある。Tone.js ベースで、Filter / FeedbackDelay / Compressor を持つ。

### Uniform Latency

全音は必ず同じ Tone ノード群を通る。エフェクト OFF でも dry だけが近道せず、
`UNIFORM_COMPENSATION_SECONDS` の固定遅延を経由する。
これにより、エフェクト処理による遅延が発生しても全音が同じだけ遅れ、位相が揃う。

## Continuity Rules

音の不自然な段差を避けるため、次の操作はすべて短いランプを通す。

- 再生開始
- 停止
- シーク
- 音量変更
- エフェクトの ON/OFF
- エフェクト値の変更

設定値は `AudioParam.setTargetAtTime()` または指数ランプで変化させる。
ノードの再接続で音色を切り替えない。

## Interaction Modes

操作モードはシーン設定から切り替える。

- クリック: ドラッグ並び替えを無効化し、`pointerdown` で最速再生する。
- ドラッグ: 並び替えを有効化し、誤発火を避けるため通常クリック再生に戻す。

## Tone.js / WASM Policy

Tone.js は EffectRack と Transport に使用している。
即時再生の発火自体は Web Audio API の `AudioBufferSourceNode.start()` 直叩きで最短を保ち、
Tone.js はその後段のエフェクト・時間管理層として機能する。

Transport、タイムコード、複数PC同期は `modules/10_tone_transport.js` 経由で Tone.Transport を使う。

WASM は標準ノードで表現できない独自 DSP、LTC 解析、高品質ピッチシフト、タイムストレッチが必要になった時に AudioWorklet と組み合わせて導入する。

## Timecode Sync & Redundancy（外部時計同期と冗長構成）

将来の同期・冗長化は、音声エンジンに直接混ぜず、別モジュールとして追加する。
現場技術調査と設計レビューを経て確定した方向を示す。詳細の調査記録は
`~/.agents/knowledge/sound-show-control-timecode/` を参照。

### コード上の境界（現状）

- `modules/06_audio.js`           即時再生、レイテンシ計測、`baseLatency`/`outputLatency`
- `modules/09_effects.js`         Tone.js エフィェクトラック、一様遅延 `UNIFORM_COMPENSATION_SECONDS = 0.006`
- `modules/10_tone_transport.js`  Tone Transport、クロックスナップショット、キュー予約
- `modules/11_midi.js`            Web MIDI（`sysex:false`、Note/CC/Program/Pitch Bend/Transport を解釈）

`sync/` 配下は現状コード上に存在しない。以降は設計意図。

### ブラウザ環境の構造的制約（前提）

1. **`AudioContext.currentTime` はオーディオデバイスクロックで駆動し、PC 間で独立**。NTP 的合意では水晶ドリフト（ppm 級）は残る。真の解は**共通外部クロックへのスレーブ化**のみ。
2. **ブラウザは UDP 非対応** → OSC/Art-Net/sACN/PTP/Ableton Link はすべてネイティブブリッジ必須。
3. **ST 2022-7 級のサンプル精度シームレス保護は不可**。2台構成の物理的上限。
4. **2台構成は quorum 不可 → 完全スプリットブレイン回避は不可能**。最悪挙動は設計で決める。
5. **Autoplay policy / バックグラウンドタブ throttling** → 本番直前のユーザジェスチャ（`AudioContext.resume()`）と前景/PWA常駐が必須。

### 主時計の選定

外部時計を優先順に使い、内部協調時計はフォールバックに徹する。

| 経路 | 入手方法 | 精度 | 備考 |
|---|---|---|---|
| **LTC（主軸）** | AudioWorklet で biphase decode、`getUserMedia` でオーディオ I/F 入力 | サンプル精度（受信タイミング）、フレーム粒度 24/25/30fps | QLab Timecode Cue と同土俵。OS 入力経路が前提 |
| **MTC（第2経路）** | Web MIDI、クォータフレーム（`0xF1`）8件→2フレーム組立 | クォータフレーム粒度、ジッタ多め | `sysex:false` でも受信可（System Common）。Full-frame locate には SysEx 要 |
| **内部協調時計（フォールバック）** | WebSocket/WebRTC で NTP 風往復測定 | ms 級、ドリフト残る | 外部 TC 喪失時の縮退先 |

### 冗長構成（silent backup をデフォルト）

両PCは同じ音源を常時再生するが、**スタンバイ側はゲイン 0（mute）** で待機。
アクティブ側の lease（リース）喪失を検出したら、スタンバイがゲインを 50-200ms でランプアップし、アクティブは即座に自己ミュートする。

「両方鳴る」はユーザが明示的に opt-in した **active-active モードのみ**。デフォルトは両方鳴らさない（プロ現場では位相差/コーミングが演出事故になるため）。

切替時の無音 gap はゲインランプ分 + lease timeout 検出遅れ。ST 2022-7 級シームレスは不可（前提3）。

### WebSocket ハブは SPOF — 以下のいずれかで解決が必須

1. ハブを**第3の独立ノード**（ミニPC/ルータ常駐プロセス）に置く（運用で担保、推奨）
2. 両PCにハブを常駐させ**リーダー選出**で片系死でも継続（複雑）
3. **P2P（WebRTC DataChannel）でハブを消す**（自動切替の要件に最も忠実、時計合意は難）

### フェーズ構成

- **Phase 0**  クロック抽象層、Autoplay/前景維持の運用ルール、音源ハッシュ一致検証
- **Phase 1a** 単純マスター・スレーブ（手動親指定）+ 音源ハッシュ一致検証
- **Phase 1b** MTC クォータフレーム受信スパイク（`11_midi.js` 拡張、`sysex:false` のまま検証）
- **Phase 2**  silent-backup 冗長 + lease/heartbeat の実機チューニング + **ハブ SPOF 解決方式の決定**（上記3択）
- **Phase 3**  LTC AudioWorklet 受信（3a: getUserMedia + エッジ検出 / 3b: biphase + 80bitフレーム / 3c: fps 推定 + TC→Transport 写像）。OS 入力経路の前提文書化を含む
- **Phase 4**  プロソフト双方向連携（OSC over WS で QLab、Ableton Link は外部ブリッジ明示）+ QLab/Reaper を含む実機検証（検証装置明示）

### Non-goals

- 音源ファイルの PC 間同期（import/export で手動配布）
- ST 2022-7 級シームレス無音切替
- Dante/AES67/ST2110/PTP/Word Clock の直接参加
- 完全スプリットブレイン回避
- Ableton Link の WASM/in-browser 直接実装（ライセンス壁）
- Safari/iOS での MTC/MSC/MMC 運用（Chromium 系 kiosk のみ）

### 実装前にユーザー承認が必要な前提

- **LTC 受信には OS レベルのオーディオ入力経路（USB I/F 結線または仮想ループバック）が必須**。これは「ブラウザ組み込み API のみ」とは別物。この前提を受け入れるか、LTC を外して MTC/内部同期のみで進めるかの選択。
- ハブ SPOF の解決方式（独立ノード / リーダー選出 / P2P）は Phase 2 開始前に決定。
