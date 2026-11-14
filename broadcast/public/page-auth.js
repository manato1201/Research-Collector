// Research Broadcast — ページ: 認証が必要
// パスワードのログインは廃止した。人は Cloudflare Access(メールで 1 クリック)で入る。
// ここに来るのは、Access を通っていない(または許可されていない)とき。

import { h, mount, renderEmpty } from "./util.js";

export function pageAuthRequired(view) {
  mount(
    view,
    h("h1", null, "認証が必要です"),
    renderEmpty(
      "Cloudflare Access でログインしてください",
      "このサイトは、許可されたメールアドレスの人だけが読めます。ページを再読み込みして、メールで届くコードを入力してください。許可されていない場合は、管理者に連絡してください。",
    ),
  );
}
