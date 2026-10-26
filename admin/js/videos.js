// admin/js/videos.js — 動画マニュアル一覧ページ（/videos.html）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole, applyViewerMode } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "/js/fs.js";
import { VIDEOS, mountVideo } from "/js/video-player.js";
import { GROUPS, PATHS, findPath } from "/js/video-catalog.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

let current = null;   // 再生中の動画ID
let tab = "learn";    // 表示中の区分（GROUPS の id）
let path = null;      // 「目的から選ぶ」で選んだ順番（PATHS の id）。null なら区分のタブで一覧を出す

const secOf = (d) => { const m = /^(\d+)分(\d+)秒$/.exec(d || ""); return m ? +m[1] * 60 + +m[2] : 0; };
const minutes = (vs) => Math.round(vs.reduce((t, v) => t + secOf(v.duration), 0) / 60);
const byId = (id) => VIDEOS.find((x) => x.id === id);

function itemHtml(v, no) {
  return `
    <button type="button" class="vl-item${current === v.id ? " active" : ""}" data-id="${v.id}" aria-pressed="${current === v.id}">
      <span class="vl-no">${esc(no ?? v.mark)}</span>
      <span class="vl-main">
        <span class="vl-title">${esc(v.label)}　${esc(v.title)}${v.notice ? ' <span class="vl-tag">改修のお知らせ</span>' : ""}</span>
        <span class="vl-desc">${esc(v.desc)}</span>
        <span class="vl-meta">${esc(v.duration)} ／ ${esc(v.version)}（${esc(v.updated)}）／ ${v.roles.map(esc).join("・")}</span>
      </span>
      <i class="ti ti-player-play vl-icon" aria-hidden="true"></i>
    </button>`;
}

// 目的から選ぶ（2026-10-26 動画ページの整理。長い説明文の代わり）
function renderPaths() {
  const box = document.getElementById("pathList");
  box.innerHTML = PATHS.map((p) => {
    const vs = p.ids.map(byId).filter(Boolean);
    return `<button type="button" class="vpath" data-path="${p.id}" aria-pressed="${path === p.id}">
      <i class="ti ${esc(p.icon)}" aria-hidden="true"></i>
      <span>${esc(p.title)}<small>${vs.length}本・約${minutes(vs)}分</small></span></button>`;
  }).join("");
  box.querySelectorAll(".vpath").forEach((b) => b.addEventListener("click", () => {
    if (path === b.dataset.path) { path = null; tab = byId(current)?.group || tab; syncMode(); return; }   // もう一度押すと解除
    path = b.dataset.path;
    select(findPath(path).ids[0], true);
  }));
}

// 区分のタブ（はじめての方／伴走支援の手順／CRMの使い方／改修のお知らせ）
function renderTabs() {
  const box = document.getElementById("groupTabs");
  box.innerHTML = GROUPS.map((g) => {
    const on = !path && tab === g.id;
    return `<button type="button" class="vtab" role="tab" id="vt-${g.id}" aria-selected="${on}" aria-controls="videoList" data-tab="${g.id}">
      <i class="ti ${esc(g.icon)}" aria-hidden="true"></i>${esc(g.title)} <span class="cnt">${VIDEOS.filter((v) => v.group === g.id).length}</span></button>`;
  }).join("");
  box.querySelectorAll(".vtab").forEach((b) => b.addEventListener("click", () => { tab = b.dataset.tab; path = null; syncMode(); }));
}

function renderList() {
  const list = document.getElementById("videoList");
  const p = path && findPath(path);
  if (p) {
    const vs = p.ids.map(byId).filter(Boolean);
    list.innerHTML = `<p class="vl-head"><span><strong>${esc(p.title)}</strong>：この順番で見てください（${vs.length}本・約${minutes(vs)}分）</span>
      <button type="button" class="btn btn-secondary" data-clear><i class="ti ti-x" aria-hidden="true"></i> 解除</button></p>`
      + vs.map((v, i) => itemHtml(v, i + 1)).join("");
    list.querySelector("[data-clear]").addEventListener("click", () => { path = null; tab = byId(current)?.group || tab; syncMode(); });
  } else {
    const g = GROUPS.find((x) => x.id === tab) || GROUPS[0];
    list.innerHTML = `<p class="vl-head">${esc(g.desc)}</p>` + VIDEOS.filter((v) => v.group === g.id).map((v) => itemHtml(v)).join("");
  }
  list.querySelectorAll(".vl-item").forEach((b) => b.addEventListener("click", () => select(b.dataset.id, true)));
}

function renderAll() { renderPaths(); renderTabs(); renderList(); }

// 表示のしかた（目的／区分）を変えたとき: 一覧・URL・「次は」の案内をまとめてそろえる
function syncMode() {
  renderAll();
  if (current) history.replaceState(null, "", `?v=${current}${path ? `&p=${path}` : ""}`);
  const el = document.getElementById("playerNext");
  if (!el.hidden) showNext(byId(current));
}

// 再生し終わったあとの「次は」の案内（自動再生はしない）
function showNext(v) {
  const next = v && nextOf(v);
  const el = document.getElementById("playerNext");
  el.hidden = !next;
  if (!next) { el.innerHTML = ""; return; }
  el.innerHTML = `次は <button type="button" class="btn btn-secondary" data-next="${next.id}"><i class="ti ti-player-skip-forward" aria-hidden="true"></i> ${esc(next.label)} ${esc(next.title)}（${esc(next.duration)}）</button>`;
  el.querySelector("[data-next]").addEventListener("click", () => select(next.id, true));
}

// 次の動画。目的の順番を選んでいればその順、そうでなければ同じ区分の中だけ（区分をまたいで勝手に進めない）
function nextOf(v) {
  const p = path && findPath(path);
  if (p && p.ids.includes(v.id)) return byId(p.ids[p.ids.indexOf(v.id) + 1]) || null;
  const same = VIDEOS.filter((x) => x.group === v.group);
  return same[same.findIndex((x) => x.id === v.id) + 1] || null;
}

async function select(id, scroll) {
  const v = VIDEOS.find((x) => x.id === id) || VIDEOS[0];
  current = v.id;
  if (path && !findPath(path)?.ids.includes(v.id)) path = null;
  if (!path) tab = v.group;
  renderAll();
  document.getElementById("playerTitle").textContent = `${v.label}　${v.title}`;
  document.getElementById("playerMeta").textContent = `${v.duration} ／ ${v.version}（${v.updated}）／ ${v.desc}`;
  document.getElementById("playerNote").textContent = v.note || (v.group === "crm" || v.group === "notice"
    ? "画面はすべてサンプルデータです。実在の事業所・担当者は写っていません。"
    : "伴走支援ガイドブック（介護情報基盤編）に沿った説明です。本体（PDF）は共有ドライブの「02_マニュアル・ガイドブック」にあります。");
  history.replaceState(null, "", `?v=${v.id}${path ? `&p=${path}` : ""}`);
  const video = await mountVideo(document.getElementById("player"), v.id, { autoplay: scroll });
  if (scroll) document.getElementById("playerCard").scrollIntoView({ behavior: "smooth", block: "start" });
  if (video) {
    // 再生し終わったら次の単元へ案内（自動再生はしない）
    video.addEventListener("ended", () => showNext(v));
    document.getElementById("playerNext").hidden = true;
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user || !user.email?.endsWith("@tadakayo.jp")) { location.href = "/index.html"; return; }
  const myRole = await gateRole(db, user);
  if (!myRole) return;
  applyViewerMode(myRole);
  const ue = document.getElementById("userEmail"); if (ue) ue.textContent = user.displayName || user.email;
  document.getElementById("logoutBtn").addEventListener("click", () => signOut(auth).then(() => location.href = "/index.html"));
  document.getElementById("gate").style.display = "none";
  document.getElementById("doc").style.display = "block";
  const qs = new URLSearchParams(location.search);
  const want = qs.get("v");
  if (findPath(qs.get("p"))) path = qs.get("p");
  await select(want && VIDEOS.some((x) => x.id === want) ? want : "L-0", false);
});
