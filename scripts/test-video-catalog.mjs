// 動画の目録（video-catalog.js）の点検。node scripts/test-video-catalog.mjs
// 同期スクリプトの名前・マニュアルの「動画で見る」ボタンと、目録が食い違っていないかを確かめる。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VIDEOS, GROUPS, findVideo } from "../admin/js/video-catalog.js";

const groupIds = GROUPS.map((g) => g.id);
const uniq = (a) => new Set(a).size === a.length;
assert.ok(uniq(VIDEOS.map((v) => v.id)), "id が重複している");
assert.ok(uniq(VIDEOS.map((v) => v.file)), "file が重複している");
for (const v of VIDEOS) {
  assert.ok(groupIds.includes(v.group), `${v.id}: group が不明（${v.group}）`);
  for (const k of ["label", "mark", "title", "duration", "version", "updated", "desc", "file"]) assert.ok(v[k], `${v.id}: ${k} が空`);
  assert.match(v.duration, /^\d+分\d{2}秒$/, `${v.id}: duration の書き方`);
  assert.match(v.updated, /^\d{4}-\d{2}-\d{2}$/, `${v.id}: updated の書き方`);
  assert.ok(Array.isArray(v.roles) && v.roles.length, `${v.id}: roles が空`);
}
for (const g of groupIds) assert.ok(VIDEOS.some((v) => v.group === g), `区分 ${g} に動画が無い`);
// 既存の ID（マニュアル・案件画面のリンク ?v=U5 など）は変えない
for (let n = 1; n <= 10; n++) assert.equal(findVideo(`U${n}`)?.file, `crm-u${n}`);

// 同期スクリプトが置く名前と、目録の file が一致する
const py = readFileSync(new URL("./sync-training-videos.py", import.meta.url), "utf8");
for (const v of VIDEOS) {
  const known = /^crm-u\d+$/.test(v.file) || /^guide-part\d$/.test(v.file) || py.includes(`"${v.file}"`);
  assert.ok(known, `${v.id}: ${v.file} を sync-training-videos.py が置かない`);
}

// マニュアルの data-video="…" はすべて目録にある
const manual = readFileSync(new URL("../admin/manual.html", import.meta.url), "utf8");
for (const [, id] of manual.matchAll(/data-video="([^"]+)"/g)) assert.ok(findVideo(id), `manual.html の data-video="${id}" が目録に無い`);

console.log(`ok video-catalog（${VIDEOS.length}本・${GROUPS.length}区分）`);
