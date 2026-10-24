// admin/js/videos.js — 動画マニュアル一覧ページ（/videos.html）
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { gateRole, applyViewerMode } from "/js/role.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "/js/fs.js";
import { VIDEOS, mountVideo } from "/js/video-player.js";
import { GROUPS } from "/js/video-catalog.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

let current = null;

function itemHtml(v) {
  return `
    <button type="button" class="vl-item${current === v.id ? " active" : ""}" data-id="${v.id}" aria-pressed="${current === v.id}">
      <span class="vl-no">${esc(v.mark)}</span>
      <span class="vl-main">
        <span class="vl-title">${esc(v.label)}　${esc(v.title)}${v.notice ? ' <span class="vl-tag">改修のお知らせ</span>' : ""}</span>
        <span class="vl-desc">${esc(v.desc)}</span>
        <span class="vl-meta">${esc(v.duration)} ／ ${esc(v.version)}（${esc(v.updated)}）／ ${v.roles.map(esc).join("・")}</span>
      </span>
      <i class="ti ti-player-play vl-icon" aria-hidden="true"></i>
    </button>`;
}

// 「伴走支援（ガイドブック）」「CRMの使い方」の2つに分けて並べる（2026-10-24 育成コース）
function renderList() {
  const list = document.getElementById("videoList");
  list.innerHTML = GROUPS.map((g) => `
    <h2 class="vl-group" id="vg-${g.id}">${esc(g.title)}<span>${esc(g.desc)}</span></h2>
    ${VIDEOS.filter((v) => v.group === g.id).map(itemHtml).join("")}`).join("");
  list.querySelectorAll(".vl-item").forEach((b) => b.addEventListener("click", () => select(b.dataset.id, true)));
}

// 同じ区分の中の次の動画（区分をまたいで勝手に進めない）
function nextOf(v) {
  const same = VIDEOS.filter((x) => x.group === v.group);
  return same[same.findIndex((x) => x.id === v.id) + 1] || null;
}

async function select(id, scroll) {
  const v = VIDEOS.find((x) => x.id === id) || VIDEOS[0];
  current = v.id;
  renderList();
  document.getElementById("playerTitle").textContent = `${v.label}　${v.title}`;
  document.getElementById("playerMeta").textContent = `${v.duration} ／ ${v.version}（${v.updated}）／ ${v.desc}`;
  document.getElementById("playerNote").textContent = v.note || (v.group === "crm"
    ? "画面はすべてサンプルデータです。実在の事業所・担当者は写っていません。"
    : "伴走支援ガイドブック（介護情報基盤編）に沿った説明です。本体（PDF）は共有ドライブの「02_マニュアル・ガイドブック」にあります。");
  history.replaceState(null, "", `?v=${v.id}`);
  const video = await mountVideo(document.getElementById("player"), v.id, { autoplay: scroll });
  if (scroll) document.getElementById("playerCard").scrollIntoView({ behavior: "smooth", block: "start" });
  if (video) {
    // 再生し終わったら次の単元へ案内（自動再生はしない）
    video.addEventListener("ended", () => {
      const next = nextOf(v);
      const el = document.getElementById("playerNext");
      el.hidden = !next;
      if (next) {
        el.innerHTML = `次は <button type="button" class="btn btn-secondary" data-next="${next.id}"><i class="ti ti-player-skip-forward" aria-hidden="true"></i> ${esc(next.label)} ${esc(next.title)}（${esc(next.duration)}）</button>`;
        el.querySelector("[data-next]").addEventListener("click", () => select(next.id, true));
      }
    });
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
  const want = new URLSearchParams(location.search).get("v");
  await select(want && VIDEOS.some((x) => x.id === want) ? want : "U1", false);
});
