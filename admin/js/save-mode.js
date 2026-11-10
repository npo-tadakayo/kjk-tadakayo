// 案件詳細の「保存のしかた」を画面に出す小さな部品（2026-11-10）。
// ・自動保存のカード（事前確認・当日・アフターのチェック）: 見出しに「入力すると自動で保存されます」
// ・保存ボタンのカード（実施の記録・トレーニング評価・伴走支援の記録・振込口座・申請情報）:
//     見出しに「『○○』を押すと保存されます」。入力を変えて未保存の間は「未保存の変更があります」と出し、
//     その状態でページを離れようとしたらブラウザの確認を出す（warehouse.js の beforeunload と同じ書き方）。
//     タブの切り替え（同じページ内）では入力は消えないので警告しない。保存に成功したら消える。
// support-checklist.js と case-detail.js の両方が "/js/save-mode.js" として読み込む＝未保存の一覧は1つ。
// DOM はイベントを受けたときにだけ触る（scripts/test-save-mode.mjs で偽の DOM を使って検査）。

export const AUTO_SAVE_NOTE = "入力すると自動で保存されます";
export const UNSAVED_TEXT = "未保存の変更があります";
export const manualSaveNote = (button = "保存") => `「${button}」を押すと保存されます`;

const MUTED = "display:block;font-size:12px;font-weight:400;color:var(--color-ink-muted)";
// 見出しの下に出す小さな説明（カード見出しの左側の <div> の中に置く）
export function saveModeNoteHtml(text) {
  return `<span class="save-mode-note" style="${MUTED}">${text}</span>`;
}
// 「未保存の変更があります」を出す場所（初期は隠す）
export function unsavedSpanHtml(id) {
  return `<span id="${id}" class="unsaved-note" role="status" style="display:none;font-size:12px;font-weight:600;color:var(--color-danger)"></span>`;
}

const dirty = new Set();
export const hasUnsaved = () => dirty.size > 0;

// beforeunload のハンドラ（未保存があるときだけブラウザの確認を出す）
export function onBeforeUnload(e) {
  if (!dirty.size) return undefined;
  e.preventDefault();
  e.returnValue = "";
  return "";
}

let bound = false;
export function bindUnloadGuard(win = typeof window === "undefined" ? null : window) {
  if (bound || !win || !win.addEventListener) return;
  bound = true;
  win.addEventListener("beforeunload", onBeforeUnload);
}

function resolve(el, doc) {
  if (typeof el !== "string") return el || null;
  return doc && doc.getElementById ? doc.getElementById(el) : null;
}

// root の中の入力（input / change）で「未保存」にする。
// status: 表示する要素か、その id（描き直される欄は id で渡す）。
// opts.match(target): 対象にする入力だけ true（省略時は root の中すべて）。
// 戻り値: { mark(), clean() 保存に成功したら呼ぶ, isDirty() }
export function trackUnsaved(key, root, status, opts = {}) {
  const doc = opts.document || (typeof document === "undefined" ? null : document);
  const show = (on) => {
    const el = resolve(status, doc);
    if (!el) return;
    el.textContent = on ? UNSAVED_TEXT : "";
    el.style.display = on ? "" : "none";
  };
  const mark = (e) => {
    if (opts.match && !opts.match(e && e.target)) return;
    dirty.add(key);
    show(true);
  };
  if (root && root.addEventListener) {
    root.addEventListener("input", mark);
    root.addEventListener("change", mark);
  }
  bindUnloadGuard(opts.window);
  return {
    mark() { dirty.add(key); show(true); }, // 入力欄以外の操作（写真を「×」で外す など）で未保存にする
    clean() { dirty.delete(key); show(false); },
    isDirty() { return dirty.has(key); },
  };
}
