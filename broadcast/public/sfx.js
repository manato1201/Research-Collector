// ステーション・ジングル(効果音)— Web Audio で合成する短い音。音声ファイルは使わない(無料・オフラインで動く)。
//
//  - open: オープニング(上がる4音)/ corner: コーナーの切り替え(2音)/ close: エンディング(下がる3音)
//  - 読み上げの前に鳴らす。効果音をオフにすると鳴らさない(player.js の設定)。
//  - AudioContext は、最初の再生ボタン(ユーザー操作)の後に作る。使えない端末では、何もせずに進む。

const NOTES = {
  open: [523.25, 659.25, 783.99, 1046.5],
  corner: [659.25, 880.0],
  close: [783.99, 659.25, 523.25],
};

let ctx = null;

function context() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** ジングルを鳴らし、鳴り終わるまでの時間(ms)を返す。鳴らせないときは 0。 */
export function jingle(kind) {
  const notes = NOTES[kind];
  const ac = context();
  if (!notes || !ac) return 0;
  if (ac.state === "suspended") ac.resume().catch(() => {});

  const step = kind === "open" ? 0.13 : 0.16;
  const t0 = ac.currentTime + 0.02;
  notes.forEach((freq, i) => {
    const start = t0 + i * step;
    const last = i === notes.length - 1;
    const len = last ? 0.55 : 0.22;
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "triangle";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.14, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + len);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + len + 0.05);
  });
  return Math.round((notes.length - 1) * step * 1000 + 600);
}
