// ===== Storage の入口（練習モードでは保存しない・2026-10-20） =====
// 練習中は写真・ファイルを Storage に上げない（本番のバケットに練習の写真が混ざらないように）。
// 読む（動画マニュアルなど）はそのまま使える。
import * as S from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { isPracticeMode } from "/js/mode.js";

export * from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

export const PRACTICE_STORAGE_MESSAGE = "練習モードのため、写真・ファイルは保存しません（本番では保存されます）";

export function uploadBytes(ref, data, meta) {
  if (isPracticeMode()) return Promise.reject(new Error(PRACTICE_STORAGE_MESSAGE));
  return S.uploadBytes(ref, data, meta);
}

export function uploadBytesResumable(ref, data, meta) {
  if (isPracticeMode()) throw new Error(PRACTICE_STORAGE_MESSAGE);
  return S.uploadBytesResumable(ref, data, meta);
}

export function deleteObject(ref) {
  // 練習中に消そうとするのは練習の記録にある写真だけ（実体は無い）なので、何もせず成功にする
  if (isPracticeMode()) return Promise.resolve();
  return S.deleteObject(ref);
}
