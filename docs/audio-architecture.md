# Audio Architecture

このアプリは、音声の安定供給と操作への応答性を優先する。音質に関わる選択は、測定値を提示した上で決める。

## Current Audio Path

### HIGH_PERFORMANCE

音声は事前に `AudioBuffer` へ decode される。通常のパッドはネイティブの
`AudioBufferSourceNode` で再生し、速度とピッチを同時に変える。速度変更時に
`preservePitch` が有効な音源だけ `Tone.GrainPlayer` をフォールバックに使う。

```text
AudioBufferSourceNode / GrainPlayer
  -> StereoPannerNode
  -> individualGain
  -> pon-voice-front (AudioWorklet: EQ3 -> Compressor -> Distortion)
  -> pon-voice-back  (AudioWorklet: Reverb mix -> Delay -> Limiter -> Meter)
  -> masterInput
  -> pon-master-front (AudioWorklet: Distortion -> EQ3 -> Compressor)
  -> pon-master-back  (AudioWorklet: Reverb mix -> Delay)
  -> masterGain
  -> pon-master-meter (AudioWorklet: meter tap)
  -> StereoPannerNode
  -> pon-master-limit (AudioWorklet: Limiter -> Safety Limiter)
  -> destination / MediaStreamDestination
```

リバーブの `ConvolverNode` は、現在の Tone.js と同じ畳み込み音を維持するため
Worklet の前後に残す。Worklet へは wet return を入力する。録音、出力先選択、
AudioContext のライフサイクル、デコードはブラウザのネイティブ機能として残る。
ドライと wet return のミックスは等パワー (constant-power) クロスフェード
(`dry·cos(rw·π/2) + wet·sin(rw·π/2)`)。無相関なドライと残響の体感音量を
ミックス位置によらず一定に保つ業界標準方式で、旧 Tone.Reverb の線形クロスフェード
(中央で -3dB 落ちる) から意図的に変更した。


### LOW_MEMORY

`<audio>` -> `MediaElementSourceNode` -> 同じ `pon-voice` rack を通る。再生データは要素に任せる。
波形表示が必要な初回だけ一時的に decode し、AudioBuffer は保持せずピーク配列だけをキャッシュする。reverse は反転
`AudioBuffer` が必要なので BufferSource 経路を使う。

ロールのパート連結は、従来どおり複数の `AudioBufferSourceNode` をオーディオ
クロックで先行スケジュールする。sustain レイヤーもそれぞれ独立した voice rack
を持つ。

## Latency and Continuity

旧実装の `UNIFORM_COMPENSATION_SECONDS`(6ms) は廃止した。Worklet 内の
Compressor/Limiter は先読みを持たず、固定の補償遅延を追加しない。これにより
ネイティブ `DynamicsCompressorNode` の固定先読みと補償遅延を削減する。

これは「全段の位相が同じ」という意味ではない。EQ の IIR フィルターには周波数
依存の位相変化があり、Reverb の pre-delay と Delay のエコー時間は効果そのもの
として残る。保証する対象は、エフェクト設定によって変動する**固定の追加遅延が
ないこと**である。

先頭サンプル位置の一致（設定によらない固定遅延の不在）は、エフェクト設定ごとの
インパルス応答で確認済み。`baseLatency` / `outputLatency` は再生デバイスごとに
異なり、全てのデバイスで10ms以下をソフトウェアだけで保証することはできない。
50ms判定は実機の `baseLatency + outputLatency` との合算で行う。

フェード、音量、パン、エフェクト値は AudioParam または Worklet 内の10ms相当の
スムージングを使う。ネイティブ BufferSource の trim 終端はオーディオクロックで
停止を予約し、メインスレッドのタイマー遅延を受けない。

## AudioWorklet DSP

`modules/worklets/pon-dsp.js` に全プロセッサを登録する。EQ3 は Tone の
`MultibandSplit` 構成、Distortion は Tone の4096点カーブ、Delay はフィードバック
付き補間ディレイを実装する。左右チャンネルのフィルター状態は独立している。
メーターは Worklet 内で256サンプル RMSを計算し、UIへ定期的に送る。

コンプレッサーとリミッターは Web Audio の gain computer を基準にしたゼロ先読み
実装である。ネイティブ `DynamicsCompressorNode` の make-up gain は現状適用して
いない。これは音量・質感に関わるため、固定する前に実機で差分を確認して決める。

## Quality Decisions Pending

次の項目は実装上の既定値を置いているが、音質の判断は行わない。

- Compressor/Limiter: ゼロ先読みのままにするか、先読みを何ms許容するか
- Compressor: ネイティブの parameter-dependent make-up gain を再現するか
- Voice `wet`: 現行仕様どおり、serial effect では wet/dry 合計を1にするか、wetを
  実際のブレンド量として修正するか
- preservePitch: GrainPlayer、`<audio>.preservesPitch`、Worklet のストレッチのどれを
  標準とするか
- Reverb: ネイティブ ConvolverNode を維持するか、Worklet 内の畳み込みへ移すか

## Modules

```text
modules/06_audio.js           playback, lifecycle, latency samples, UI integration
modules/09_effects.js         Worklet rack, native Convolver wiring, master controls
modules/worklets/pon-dsp.js   AudioWorklet DSP processors
modules/10_tone_transport.js  Tone Transport, clock snapshot, cue scheduling
```
