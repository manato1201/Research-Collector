// 読み上げの声の選び方(DOM に依存しない純粋な関数。node でテストできる)
//
// 端末には日本語の声が複数あることが多く、ブラウザが先頭に返すのは品質の低い標準の声になりがち。
// 名前から品質の見当をつけ、いちばん自然に聞こえそうな声を「おまかせ」で選ぶ。
//   高 (100): Natural / Neural / Online(Edge・Windows のオンライン音声)、Premium / Enhanced(Apple)、Siri
//   中  (60): Google の日本語(ネットワーク音声)
//   低  (10): 端末内の標準の声(Haruka・Ayumi・Kyoko など)
//   除外(-100): eSpeak など、機械的な声

const HIGH = /natural|neural|online|premium|enhanced|siri|プレミアム|拡張|高品質/i;
const MID = /google/i;
const ROBOTIC = /espeak|festival|robot/i;

export const isJapanese = (v) => String(v?.lang ?? "").toLowerCase().replace("_", "-").startsWith("ja");

/** 声の品質の見当(大きいほど自然)。同点は、ネットワーク音声をわずかに上にする。 */
export function voiceScore(v) {
  const name = String(v?.name ?? "");
  let s = 10;
  if (HIGH.test(name)) s = 100;
  else if (MID.test(name)) s = 60;
  if (ROBOTIC.test(name)) s = -100;
  if (v?.localService === false) s += 1;
  return s;
}

export const isHighQuality = (v) => voiceScore(v) >= 60;

/** 日本語の声を、自然そうな順に並べる(同点は、元の並びのまま)。 */
export function rankVoices(voices) {
  return (voices ?? [])
    .filter(isJapanese)
    .map((v, i) => ({ v, i, s: voiceScore(v) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.v);
}

/** 使う声。ユーザーが選んだ声があればそれ、なければ「おまかせ」(いちばん自然そうな日本語の声)。 */
export function pickBestVoice(voices, savedName = "") {
  const ranked = rankVoices(voices);
  return ranked.find((v) => savedName && v.name === savedName) ?? ranked[0] ?? null;
}

/** 選択肢に出す名前。高品質そうな声には印を付ける。 */
export const voiceLabel = (v) => (isHighQuality(v) ? `${v.name} ★高品質` : v.name);
