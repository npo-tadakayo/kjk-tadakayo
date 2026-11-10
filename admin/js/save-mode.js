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

// 未保存の間に、他の人の更新で保存済みの値が変わったときの一言
export const CONFLICT_TEXT = "他の人が更新しました。保存すると上書きします。最新を見るには再読み込みしてください";

// 比べるための文字列（キーの順番に左右されない）。updatedAt / createdAt は比べない（サーバー時刻で変わるため）
export function stableKey(v) {
  const walk = (x) => {
    if (x === undefined) return null;
    if (x === null || typeof x !== "object") return x;
    if (Array.isArray(x)) return x.map(walk);
    if (typeof x.toMillis === "function") return { $ts: x.toMillis() };
    const o = {};
    for (const k of Object.keys(x).sort()) { if (k !== "updatedAt" && k !== "createdAt") o[k] = walk(x[k]); }
    return o;
  };
  return JSON.stringify(walk(v));
}

// 未保存の一覧から全部外す（削除・ログアウトなど、自分で画面を離れるときに確認を出さないため）
export function discardUnsaved() { dirty.clear(); }

// root の中の入力（input / change）で「未保存」にする。
// status: 表示する要素か、その id（描き直される欄は id で渡す）。
// opts.match(target): 対象にする入力だけ true（省略時は root の中すべて）。
// opts.active(): false の間は見張らない（例: トレーナーでない人の評価欄＝保存できないので未保存にしない）。
// 戻り値:
//   mark()                 入力欄以外の操作（写真を「×」で外す など）で未保存にする
//   clean()                保存に成功したら呼ぶ
//   isDirty()
//   rescope(id, note)      入力の対象（評価IDなど）が変わったら未保存の入力を捨てる。捨てたら true（note を表示）
//   observe(saved, {own})  届いた保存済みの値。未保存の間に他の人の更新で変わっていたら CONFLICT_TEXT を出す。
//                          自分の書き込みの通知（own=true: hasPendingWrites）では出さない
export function trackUnsaved(key, root, status, opts = {}) {
  const doc = opts.document || (typeof document === "undefined" ? null : document);
  let conflict = false, note = "", lastText = null, scope, base, hasBase = false;
  // 状態が変わったときだけ書き込む（同じ文言を何度も書くと読み上げが繰り返されるため）
  const render = () => {
    const on = dirty.has(key);
    const text = on ? (conflict ? `${UNSAVED_TEXT}。${CONFLICT_TEXT}` : UNSAVED_TEXT) : note;
    if (text === lastText) return;
    const el = resolve(status, doc);
    if (!el) return;
    lastText = text;
    el.textContent = text;
    el.style.display = text ? "" : "none";
  };
  const setDirty = () => { note = ""; dirty.add(key); render(); };
  const onInput = (e) => {
    if (opts.active && !opts.active()) return;
    if (opts.match && !opts.match(e && e.target)) return;
    setDirty();
  };
  if (root && root.addEventListener) {
    root.addEventListener("input", onInput);
    root.addEventListener("change", onInput);
  }
  bindUnloadGuard(opts.window);
  const clean = () => { dirty.delete(key); conflict = false; note = ""; hasBase = false; render(); };
  return {
    mark: setDirty,
    clean,
    isDirty() { return dirty.has(key); },
    rescope(id, discardNote = "") {
      const changed = scope !== undefined && id !== scope;
      scope = id;
      if (!changed || !dirty.has(key)) return false;
      clean();
      note = discardNote;
      lastText = null; // 描き直された欄でも出す
      render();
      return true;
    },
    observe(saved, { own = false } = {}) {
      const k = stableKey(saved);
      if (!dirty.has(key) || own || !hasBase) { base = k; hasBase = true; if (!dirty.has(key)) conflict = false; render(); return false; }
      if (k !== base) { conflict = true; base = k; }
      render();
      return conflict;
    },
  };
}

// 保存済みの値を入力欄へ流し込んでよいか（評価欄など）。
// 対象（scopeId＝評価ID）が変わったら未保存の入力は捨てて必ず流し込み直す。変わらなければ、
// 入力中（focused）か未保存のときは流し込まない（入力を残す）
export function shouldRefillForm(tracker, scopeId, focused, discardNote = "") {
  const discarded = tracker.rescope(scopeId, discardNote);
  return discarded || !(focused || tracker.isDirty());
}
