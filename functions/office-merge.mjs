// 事業所の編集・統合の判定（純粋関数のみ。DOM・Firestore に触れない・import なし）。
// 設計: docs/顧客情報の修正メニュー_設計_20261024.md §7（2026-10-24 確定）。
// 正本はこのファイル。functions/office-merge.mjs はバイト単位で同じコピー（scripts/check-shared-sync.sh で照合）。
// 画面（offices.js・練習モードの代役）と Functions（updateOffice / mergeOffices / unmergeOffice・findActiveCase・見積もり作成）が同じ判定を使う。
// テスト: node scripts/test-office-merge.mjs

// 編集・統合で書き換えてよい項目（これ以外は invalid-argument）
export const EDITABLE_FIELDS = ["officeName", "corpName", "address", "phone", "postalCode"];
const MAX_LEN = 200;
const MAX_HOPS = 5; // mergedInto をたどる上限（循環・長い鎖で止まらないように）

// 事業所名の比較用。空白（全角含む）・括弧・中黒を除き、NFKC で全角半角をそろえ、小文字にする。
// 「（株）タダカヨ 訪問介護」と「(株)タダカヨ訪問介護」を同じとみなすため。
export function normName(s) {
  return String(s == null ? "" : s)
    .normalize("NFKC")
    .replace(/[\s　（）()「」【】『』・･·]/g, "")
    .toLowerCase();
}
// 電話番号の比較用（数字だけ）
export function normPhone(s) {
  return String(s == null ? "" : s).normalize("NFKC").replace(/\D/g, "");
}
// 住所の比較用（NFKC・空白を除く）
export function normAddr(s) {
  return String(s == null ? "" : s).normalize("NFKC").replace(/[\s　]/g, "");
}

const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (v == null ? "" : String(v)).trim();

// updateOffice の patch を検証し、きれいにした patch を返す。
// 入れてよいのは EDITABLE_FIELDS だけ・文字列だけ・前後空白を除く・各200字まで・事業所名は空にできない。
export function validatePatch(patch) {
  if (!isObj(patch)) return { ok: false, error: "変更内容の形が正しくありません" };
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: false, error: "変更する項目がありません" };
  const out = {};
  for (const k of keys) {
    if (!EDITABLE_FIELDS.includes(k)) return { ok: false, error: `この項目は変更できません: ${k}` };
    const v = patch[k];
    if (typeof v !== "string") return { ok: false, error: `${k} は文字で入れてください` };
    const t = v.trim();
    if (t.length > MAX_LEN) return { ok: false, error: `${k} は${MAX_LEN}字以内で入れてください` };
    out[k] = t;
  }
  if ("officeName" in out && !out.officeName) return { ok: false, error: "事業所名は空にできません" };
  return { ok: true, patch: out };
}

// 統合で残す側の値を決める。keep[項目] が "from" なら消える側、それ以外（省略含む）は残す側。
// 選んだ側が空で反対側に値があれば、値のある方を使う（片方だけ値があれば自動で残す）。
export function resolveKeep(from, to, keep) {
  const f = from || {}, t = to || {}, k = keep || {};
  const out = {};
  for (const key of EDITABLE_FIELDS) {
    const a = str(f[key]), b = str(t[key]);
    const pick = k[key] === "from" ? a : b;
    const other = k[key] === "from" ? b : a;
    out[key] = pick || other || "";
  }
  return out;
}

// 残す側の aliases（旧名）を組み立てる。to の aliases → from の aliases → to の事業所名 → from の事業所名 の順に
// 足し、最終の事業所名と空を除き、normName で重複を除く（最初に出た表記を残す）。
export function buildAliases(to, from, finalOfficeName) {
  const t = to || {}, f = from || {};
  const list = [
    ...(Array.isArray(t.aliases) ? t.aliases : []),
    ...(Array.isArray(f.aliases) ? f.aliases : []),
    t.officeName, f.officeName,
  ];
  const finalKey = normName(finalOfficeName);
  const seen = new Set(), out = [];
  for (const v of list) {
    const s = str(v);
    const key = normName(s);
    if (!key || key === finalKey || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// 統合してよいか。from（消える側）・to（残す側）は doc の中身（無ければ null/undefined）。
// from が同じ to へ統合中（mergeStatus:"running"）なら resume:true（続きから再開）。
export function checkMerge(from, to, fromId, toId) {
  if (!fromId || !toId || typeof fromId !== "string" || typeof toId !== "string") {
    return { ok: false, code: "invalid-argument", error: "統合する2つの事業所を指定してください" };
  }
  if (fromId === toId) return { ok: false, code: "invalid-argument", error: "同じ事業所どうしは統合できません" };
  if (!from || !to) return { ok: false, code: "not-found", error: "事業所が見つかりません（削除された可能性があります）" };
  if (to.mergedInto) return { ok: false, code: "failed-precondition", error: "残す側の事業所はすでにほかの事業所に統合されています" };
  if (from.mergedInto) {
    if (from.mergedInto !== toId) return { ok: false, code: "failed-precondition", error: "この事業所はすでに別の事業所に統合されています" };
    if (from.mergeStatus === "running") return { ok: true, resume: true };
    return { ok: false, code: "failed-precondition", error: "この事業所はすでにこの事業所に統合済みです" };
  }
  return { ok: true, resume: false };
}

// mergedInto をたどって、いま残っている事業所の ID を返す（最大5段）。
// 循環・行き先の事業所が無いときは、その手前で止まる。getById は id → doc の中身|undefined（同期）。
export function resolveMergedId(id, getById) {
  if (!id) return id;
  let cur = id;
  const seen = new Set([cur]);
  let d = getById(cur);
  for (let i = 0; i < MAX_HOPS; i++) {
    const next = d && d.mergedInto;
    if (!next || seen.has(next)) return cur;
    const nd = getById(next);
    if (!nd) return cur;
    seen.add(next);
    cur = next; d = nd;
  }
  return cur;
}
// 非同期版（Functions で offices を1件ずつ読むとき）。getByIdAsync は id → Promise<doc|undefined>
export async function resolveMergedIdAsync(id, getByIdAsync) {
  if (!id) return id;
  let cur = id;
  const seen = new Set([cur]);
  let d = await getByIdAsync(cur);
  for (let i = 0; i < MAX_HOPS; i++) {
    const next = d && d.mergedInto;
    if (!next || seen.has(next)) return cur;
    const nd = await getByIdAsync(next);
    if (!nd) return cur;
    seen.add(next);
    cur = next; d = nd;
  }
  return cur;
}

// 問い合わせの事業所名 name が、案件（事業所名の写し caseOfficeName）とその事業所 office に一致するか。
// 完全一致は従来どおり必ず true（findActiveCase の挙動を変えない）。加えて normName で
// 案件の写し・事業所の現在名・aliases（旧名・統合で消えた側の名前）のどれかと同じなら true。
export function nameMatchesOffice(name, caseOfficeName, office) {
  if ((name || "") === (caseOfficeName || "")) return true;
  const n = normName(name);
  if (!n) return false;
  if (n === normName(caseOfficeName)) return true;
  const o = office || {};
  if (n === normName(o.officeName)) return true;
  return (Array.isArray(o.aliases) ? o.aliases : []).some((a) => normName(a) === n);
}

// 取り消しで戻してよい ID（いまも officeId が残す側のものだけ。統合後に別へ動かしたものは触らない）。
// currentOfficeIdById は Map・関数（id → officeId）・普通のオブジェクトのどれでもよい。
export function pickRestorable(ids, currentOfficeIdById, toId) {
  const m = currentOfficeIdById;
  const get = typeof m === "function" ? m
    : m instanceof Map ? (id) => m.get(id)
      : (id) => (m && Object.prototype.hasOwnProperty.call(m, id) ? m[id] : undefined);
  return (Array.isArray(ids) ? ids : []).filter((id) => toId && get(id) === toId);
}

// 統合で残す側（to）に書いた値（mergeWrote）と比べる項目。住所は見積書の宛名が読む3つの分割も含める
export const TO_RESTORE_FIELDS = [...EDITABLE_FIELDS, "prefecture", "city", "addressDetail"];

// 統合の取り消しで、残す側（to）の値を統合前（mergeToBefore）に戻してよいか。
// 統合のあとに to が編集されていない（いまの値が統合で書いた値 wrote のまま）ときだけ true。
// 編集されていたら戻さない（人が直した値を取り消しで消さないため）。wrote が無い（古い統合）ときも false。
export function canRestoreTo(currentTo, wrote) {
  if (!currentTo || !isObj(wrote)) return false;
  return TO_RESTORE_FIELDS.every((f) => str(currentTo[f]) === str(wrote[f]));
}

// 重複の理由（同じ名前・同じ電話・同じ住所）。電話は9桁以上のときだけ比べる。
function dupReasons(a, b) {
  const r = [];
  const na = normName(a.officeName);
  if (na && na === normName(b.officeName)) r.push("name");
  const pa = normPhone(a.phone);
  if (pa.length >= 9 && pa === normPhone(b.phone)) r.push("phone");
  const aa = normAddr(a.address);
  if (aa && aa === normAddr(b.address)) r.push("address");
  return r;
}

// 統合の相手の候補。offices は [{ id, ...doc }]。自分自身と統合済み（mergedInto あり）は除く。
// 戻り値 [{ id, reasons }]（理由の多い順。同数は元の並び）
export function dupCandidates(office, offices) {
  if (!office) return [];
  const out = [];
  for (const o of offices || []) {
    if (!o || o.id === office.id || o.mergedInto) continue;
    const reasons = dupReasons(office, o);
    if (reasons.length) out.push({ id: o.id, reasons });
  }
  return out
    .map((x, i) => ({ x, i }))
    .sort((p, q) => q.x.reasons.length - p.x.reasons.length || p.i - q.i)
    .map((p) => p.x);
}

// 重複の候補の組の数（統合済みを除き、どれかの理由でつながる事業所を1組とする。2件以上の組だけ数える）
export function dupGroupCount(offices) {
  const list = (offices || []).filter((o) => o && !o.mergedInto);
  const parent = list.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  // 正規化した値ごとに束ねる（全組み合わせを比べない）
  const byKey = new Map();
  list.forEach((o, i) => {
    const keys = [];
    const n = normName(o.officeName); if (n) keys.push("n:" + n);
    const p = normPhone(o.phone); if (p.length >= 9) keys.push("p:" + p);
    const a = normAddr(o.address); if (a) keys.push("a:" + a);
    for (const k of keys) {
      if (byKey.has(k)) union(i, byKey.get(k)); else byKey.set(k, i);
    }
  });
  const size = new Map();
  list.forEach((_, i) => { const r = find(i); size.set(r, (size.get(r) || 0) + 1); });
  let groups = 0;
  for (const s of size.values()) if (s >= 2) groups++;
  return groups;
}
