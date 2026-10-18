// 実施の記録（support-performance.js）の単体テスト。node scripts/test-support-performance.mjs
import assert from "node:assert/strict";
import { buildPerformance, summaryLine } from "../admin/js/support-performance.js";

const users = [{ _id: "a@tadakayo.jp", name: "山田" }, { _id: "t@tadakayo.jp", name: "鈴木" }];
const base = { date: "2026-10-18", performerId: "a@tadakayo.jp", mode: "solo" };
const b = (o) => buildPerformance({ ...base, ...o }, users, "me", "NOW");

assert.match(b({ date: "" }).error, /実施日/);
assert.match(b({ performerId: "" }).error, /実施者/);
assert.match(b({ mode: "" }).error, /区分/);
assert.match(b({ mode: "training" }).error, /トレーナー/);
assert.ok(b({ mode: "training", trainerId: "t@tadakayo.jp", companions: "佐藤" }).performance);
const solo = b({ companions: "無視される", trainerId: "t@tadakayo.jp" }).performance;
assert.equal(solo.companions, "");
assert.equal(solo.trainerName, "鈴木");
assert.equal(b({ mode: "observe", companions: "A, B" }).performance.companions, "A, B");
assert.equal(summaryLine(solo), "実施：2026-10-18／実施者：山田／区分：単独／トレーナー：鈴木");
assert.equal(summaryLine({ date: "2026-10-18", performerName: "山田", mode: "training", trainerName: "鈴木" }),
  "実施：2026-10-18／実施者：山田／区分：トレーニング／トレーナー：鈴木");
assert.equal(summaryLine(null), "");
console.log("ok");
