// admin/js/learning-quiz.js — 育成コースの確認テスト（STEP1〜4）の問題（SSOT）
// 仕様: docs/伴走支援者育成プログラム_提案_20261024.md §3
//   - 選択式。answer は choices の何番目が正解か（0 から数える）。画面では選択肢の順番を並べ替えて出す
//   - pass.ratio 以上の正答率で合格。safety: true の問題は、ratio に関係なく必ず正解が要る
//   - STEP1 は約束10項目（docs/動画B_伴走支援者の約束_項目案_20261024.md）から1問ずつ・全問正解が合格
//   - src は出典（動画のID・場面、またはガイドブックのページ）。問題を直すときは出典を見て直す
//   - 利用者（被保険者）の個人情報・実在の事業所名は入れない
// ⚠ この形（キー名）は learning.js が読む。変えるときは learning.js と scripts/test-learning-quiz.mjs も直す
export const QUIZZES = {
  S1: { title: "伴走支援者の約束", pass: { ratio: 1 }, questions: [] },
  S2: { title: "介護情報基盤を知る", pass: { ratio: 0.8 }, questions: [] },
  S3: { title: "伴走支援の手順", pass: { ratio: 0.8 }, questions: [] },
  S4: { title: "CRMの使い方", pass: { ratio: 0.8 }, questions: [] },
};
// 1問の形: { id: "S1-01", q: "問題文", choices: ["…", "…", "…"], answer: 0, why: "解説（正解の理由）", src: "L-B 場面02", safety: true }
