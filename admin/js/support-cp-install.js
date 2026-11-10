// ケアプラン連携の「導入状況」（伴走支援チェックリストの事前確認タブ）。
// 保存先: supportChecklists/{caseId}.cp.installStatus（"" 未確認／"new" 未導入（今回導入する）／"installed" 導入済み）。
// 「導入済み」のときは、事前確認の 対応ソフト・電子請求の有無・証明書の種類 と、
// 当日の導入作業（6工程）・証憑写真の欄を畳んで「省略します」と表示する。
// 入力済みのデータは消さない（畳むだけ。「導入済み」を外せば元どおり見える）。
// 完了判定（case-complete-check.js）・育成の判定（learning-core.js）には使わない。
// DOM 以外の依存が無い（scripts/test-support-cp-install.mjs で検査）。

export const CP_INSTALL_OPTS = [
  { v: "", t: "未確認" },
  { v: "new", t: "未導入（今回導入する）" },
  { v: "installed", t: "導入済み" },
];

export const CP_SKIP_PRE_TEXT = "ケアプランデータ連携システムは導入済みのため、事前確認は省略します";
export const CP_SKIP_ONSITE_TEXT = "ケアプランデータ連携システムは導入済みのため、当日の作業は省略します";

// installStatus が無い既存の案件は「未確認」＝今までどおり全部表示
export function cpInstalled(cp) {
  return !!cp && cp.installStatus === "installed";
}

// root の中の [data-cp-skip]（畳む欄）と [data-cp-skip-note]（省略の表示）を切り替える
export function applyCpInstalled(root, installed) {
  if (!root || !root.querySelectorAll) return;
  root.querySelectorAll("[data-cp-skip]").forEach((el) => { el.style.display = installed ? "none" : ""; });
  root.querySelectorAll("[data-cp-skip-note]").forEach((el) => { el.style.display = installed ? "" : "none"; });
}
