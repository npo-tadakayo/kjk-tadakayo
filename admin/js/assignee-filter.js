// ===== 担当者の絞り込みと並び替えの共通部品（2026-10-20） =====
// カンバン・案件一覧・ホーム・事業所・出荷の各画面で「自分の担当だけ」を見られるようにする。
//
// 担当は案件の assignedUserId（= users のドキュメントID＝メールアドレス）で持っている。
// 職員は users を一覧で読めない（ルールで本人と管理者のみ）ので、選択肢の名前は
// 画面が読み込んだ案件の assignedUserId / assignedUserName から作る。
//
// 選んだ状態はブラウザに覚えさせる（画面の設定だけ。利用者・事業所の情報は保存しない）。
// プライベートウィンドウ等で使えないときは、覚えないだけで画面は普通に動く。

export const ASSIGNEE_ALL = "";
export const ASSIGNEE_ME = "__me";
export const ASSIGNEE_NONE = "__none";

const norm = (s) => String(s || "").trim().toLowerCase();

/** 担当（assignedUserId）が、選んだ絞り込み値に当てはまるか。 */
export function matchAssignee(assignedUserId, value, myEmail) {
  if (!value) return true;
  const id = norm(assignedUserId);
  if (value === ASSIGNEE_ME) return !!id && id === norm(myEmail);
  if (value === ASSIGNEE_NONE) return !id;
  return id === norm(value);
}

/** 複数の担当（事業所＝複数案件・出荷＝元案件）のどれかが当てはまるか。 */
export function matchAnyAssignee(ids, value, myEmail) {
  if (!value) return true;
  const list = (ids || []).length ? ids : [null];
  if (value === ASSIGNEE_NONE) return list.every((id) => !norm(id));
  return list.some((id) => matchAssignee(id, value, myEmail));
}

/**
 * 担当の絞り込みセレクトに選択肢を入れる。
 * cases: assignedUserId / assignedUserName を持つ配列（案件そのもの）。
 * いま選ばれている値は、候補から消えても保つ（読み込みのたびに「全員」へ戻らないように）。
 */
export function fillAssigneeSelect(sel, cases, myEmail) {
  if (!sel) return;
  const cur = sel.value;
  const me = norm(myEmail);
  const names = new Map();
  (cases || []).forEach((c) => {
    const id = norm(c.assignedUserId);
    if (!id || id === me) return;
    if (!names.has(id) || !names.get(id)) names.set(id, c.assignedUserName || "");
  });
  const people = [...names.entries()]
    .map(([id, name]) => ({ id, name: name || id }))
    .sort((a, b) => a.name.localeCompare(b.name, "ja"));
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  let html = `<option value="${ASSIGNEE_ALL}">担当：全員</option>`
    + `<option value="${ASSIGNEE_ME}">担当：自分</option>`
    + `<option value="${ASSIGNEE_NONE}">担当：未割当</option>`;
  if (people.length) {
    html += `<optgroup label="ほかの担当者">`
      + people.map((p) => `<option value="${esc(p.id)}">担当：${esc(p.name)}</option>`).join("")
      + `</optgroup>`;
  }
  sel.innerHTML = html;
  const keep = cur || sel.dataset.pref || "";
  sel.value = keep;
  if (sel.value !== keep) {
    // 覚えていた人が今の一覧にいない（担当案件が無くなった等）。「全員」に戻す
    sel.value = ASSIGNEE_ALL;
  }
}

/** 画面の設定を読む（無ければ fallback）。 */
export function loadPref(key, fallback = "") {
  try {
    const v = localStorage.getItem(`crm.pref.${key}`);
    return v === null ? fallback : v;
  } catch (_) { return fallback; }
}

/** 画面の設定を覚える。 */
export function savePref(key, value) {
  try { localStorage.setItem(`crm.pref.${key}`, value ?? ""); } catch (_) {}
}

/**
 * セレクトを「覚えた値で始めて、変えたら覚え直す」ようにつなぐ。
 * onChange は変更のたびに呼ぶ（描画し直し）。
 */
export function bindPrefSelect(sel, key, onChange) {
  if (!sel) return;
  const v = loadPref(key, sel.value);
  sel.dataset.pref = v;
  sel.value = v;
  if (sel.value !== v) sel.value = sel.options[0]?.value ?? "";
  sel.addEventListener("change", () => {
    sel.dataset.pref = sel.value;
    savePref(key, sel.value);
    onChange && onChange();
  });
}

/** Firestore の Timestamp／日付文字列／Date を ms に（無ければ 0）。 */
export function toMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === "function") return v.toMillis();
  if (v instanceof Date) return v.getTime();
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}
