// 案件詳細の出荷タブに出す「発送の段」（受付・入荷待ち・発送不可・確認待ち・発送準備）の組み立て（純粋 ESM・2026-11-13）。
// 表示だけ。書き込みはしない。判定は ship-steps-rules.js の stepOf が正本（供給管理の一覧と同じ判定を使う）。
// firebase を import しない（node の単体テスト scripts/test-case-ship-step.mjs から直接読む）。
import { stepOf, STEP_LABEL, STEP_BADGE } from "./ship-steps-rules.js";

// 段のチップ・バッジの説明（吹き出し）。供給管理（supply.js）と案件詳細で同じ言い方にするためここを正本にする
export const STEP_TIPS = {
  "": "すべての出荷を出します",
  draft: "まだ依頼していない出荷です。「出荷を依頼する」で倉庫へ依頼します",
  accept: "倉庫が在庫と照らして「発送可・入荷待ち・発送不可」を選ぶのを待っている依頼です",
  confirm: "倉庫で発送できると返事があった依頼です。依頼した人が最終確認（OK・変更・キャンセル）をします",
  wait: "発送はできるが、在庫の入荷を待っている依頼です（依頼は出したまま）",
  ng: "倉庫で発送できなかった依頼です。倉庫を選び直すか、入力を直して依頼し直します",
  prepare: "倉庫が宛名印刷・梱包・発送をする依頼です。納品希望日の早い順に並びます",
  done: "発送済・受け渡し済の出荷です。請求書・入金・領収証の画面へここから進めます",
  canceled: "キャンセルした出荷です（理由と日時）",
};

// 段のバッジ。依頼済（status === "requested"）のときだけ返す。それ以外は "" （今までの表示のまま）。
// opts.finalConfirm … 最終確認を行う設定か（finalConfirmOn(settings) の値）。opts.esc … HTML エスケープ関数
export function shipStepBadgeHtml(s, opts = {}) {
  if (!s || s.status !== "requested") return "";
  const esc = opts.esc || ((v) => String(v == null ? "" : v));
  const step = stepOf(s, { finalConfirm: opts.finalConfirm });
  return `<span class="badge badge-${STEP_BADGE[step] || 2}" data-tip="${esc(STEP_TIPS[step] || "")}">${esc(STEP_LABEL[step] || "")}</span>`;
}
