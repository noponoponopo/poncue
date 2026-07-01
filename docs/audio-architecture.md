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

## Future Extension Points

将来の同期・冗長化は、音声エンジンに直接混ぜず、別モジュールとして追加する。

```text
modules/06_audio.js           immediate playback, latency meter
modules/09_effects.js         Tone.js effect rack (uniform latency)
modules/10_tone_transport.js  Tone Transport, clock snapshot, cue scheduling
sync/clock-sync.js            peer clock offset and drift (future)
sync/cue-protocol.js          scene/sound cue messages (future)
sync/redundancy.js            primary/secondary behavior (future)
```
