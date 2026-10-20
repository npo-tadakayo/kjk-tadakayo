// ===== Cloud Functions の入口（練習モードでは呼ばない・2026-10-20） =====
// 練習中は httpsCallable が本物の Functions を呼ばず、practice-stubs.js の代役を返す。
// メール・Chat・PDF保存・AI はどれも外へ出ない（代役が「送ったことにする」記録だけを練習DBに書く）。
// 代役の無い Functions を練習中に呼ぶと、送らずにエラーで止める（黙って本番を呼ばない）。
import * as FN from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { isPracticeMode } from "/js/mode.js";
import { PRACTICE_STUBS } from "/js/practice-stubs.js";

export * from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";

export function httpsCallable(functions, name, opts) {
  if (!isPracticeMode()) return FN.httpsCallable(functions, name, opts);
  return async (data) => {
    const stub = PRACTICE_STUBS[name];
    if (!stub) throw new Error(`練習モードでは「${name}」は使えません（本番の操作のため）`);
    return { data: await stub(data || {}) };
  };
}
