// 保存済みのテーマを、描画前に適用する(ちらつき防止)。インライン script を避けるため別ファイル(CSP)
try {
  var t = localStorage.getItem("rb-theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
} catch (e) {}
