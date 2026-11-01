// 事業所の新規登録（offices への追加だけ・2026-11-01）。
// offices.js は「既存の事業所の書き換え（編集・統合）は Callable だけ」を守るため、Firestore に直接書かない
// （scripts/test-office-ui.mjs で検査）。新規登録は既存の案件の表示名などに波及しない「追加」だけなので、
// 案件一覧の新規登録（cases.js の createCase）と同じく画面から offices に addDoc する。ここは追加だけで、
// 既存の文書の更新・削除はしない（同じ検査で確かめる）。書き込み権限はルールの isEditor（閲覧のみは拒否）。
// 練習モードでは fs.js が練習DBに向け、作成者（_practiceBy）を付ける。
import { collection, addDoc, serverTimestamp } from "/js/fs.js";
import { buildNewOffice } from "/js/case-copy.js";

/** 入力を確かめて offices に追加する。戻り値 { ok, id } または { ok:false, error } */
export async function createOffice(db, input) {
  const built = buildNewOffice(input, { now: serverTimestamp() });
  if (!built.ok) return built;
  const ref = await addDoc(collection(db, "offices"), built.data);
  return { ok: true, id: ref.id, data: built.data };
}
