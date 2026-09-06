// admin/js/video-player.js — 動画マニュアルの再生部品（マニュアル内のモーダル再生・動画ページの埋め込み再生の両方で使う）
// - 動画は Firebase Storage `training/` から getDownloadURL で取る（ログイン済み @tadakayo.jp だけが読める）
// - 字幕は同名の .vtt を <track> で付ける（音を出せない現場でも読める）
// - 使い方: openVideoModal("U5") ／ mountVideo(container, "U5")
//   マニュアル側は <button data-video="U5"> を置けば、このモジュールがクリックを拾ってモーダルを開く
import { getApps } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getStorage, ref, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";
import { VIDEOS, VIDEO_STORAGE_PREFIX, findVideo } from "/js/video-catalog.js";

const urlCache = new Map();

async function mediaUrls(v) {
  if (urlCache.has(v.id)) return urlCache.get(v.id);
  const app = getApps()[0];
  if (!app) throw new Error("Firebase が初期化されていません");
  const storage = getStorage(app);
  const [mp4, vtt] = await Promise.all([
    getDownloadURL(ref(storage, `${VIDEO_STORAGE_PREFIX}${v.file}.mp4`)),
    getDownloadURL(ref(storage, `${VIDEO_STORAGE_PREFIX}${v.file}.vtt`)).catch(() => null),
  ]);
  const out = { mp4, vtt };
  urlCache.set(v.id, out);
  return out;
}

function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/** container に <video> を描いて再生できる状態にする。戻り値は video 要素 */
export async function mountVideo(container, id, { autoplay = false } = {}) {
  const v = findVideo(id);
  if (!v) { container.innerHTML = `<p class="vp-error">動画が見つかりません（${esc(id)}）</p>`; return null; }
  container.innerHTML = `<div class="vp-loading"><i class="ti ti-loader-2 ti-spin" aria-hidden="true"></i> 動画を読み込んでいます...</div>`;
  try {
    const { mp4, vtt } = await mediaUrls(v);
    container.innerHTML = `
      <video class="vp-video" controls playsinline preload="metadata" crossorigin="anonymous" ${autoplay ? "autoplay" : ""}
             aria-label="単元${v.no} ${esc(v.title)}">
        <source src="${esc(mp4)}" type="video/mp4">
        ${vtt ? `<track kind="subtitles" srclang="ja" label="日本語字幕" src="${esc(vtt)}" default>` : ""}
        お使いのブラウザは動画の再生に対応していません。
      </video>`;
    return container.querySelector("video");
  } catch (e) {
    container.innerHTML = `<p class="vp-error"><i class="ti ti-alert-triangle" aria-hidden="true"></i> 動画を読み込めませんでした（${esc(e?.code || e?.message || e)}）。ログインし直すか、通信状態をご確認ください。</p>`;
    return null;
  }
}

// ---- モーダル（マニュアルを読みながら見る用）----
let modal = null;
function ensureModal() {
  if (modal) return modal;
  injectStyle();
  modal = document.createElement("div");
  modal.className = "vp-overlay";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "vpTitle");
  modal.hidden = true;
  modal.innerHTML = `
    <div class="vp-box">
      <div class="vp-head">
        <div>
          <div class="vp-kicker">動画マニュアル</div>
          <h2 id="vpTitle" class="vp-title"></h2>
        </div>
        <button type="button" class="vp-close" aria-label="閉じる" title="閉じる"><i class="ti ti-x" aria-hidden="true"></i></button>
      </div>
      <div class="vp-body"></div>
      <div class="vp-foot">
        <span class="vp-meta"></span>
        <a class="vp-all" href="/videos.html"><i class="ti ti-video" aria-hidden="true"></i> すべての動画を見る</a>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.querySelector(".vp-close").addEventListener("click", closeVideoModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeVideoModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeVideoModal(); });
  return modal;
}

let lastFocus = null;
export async function openVideoModal(id) {
  const v = findVideo(id);
  if (!v) return;
  const m = ensureModal();
  lastFocus = document.activeElement;
  m.querySelector(".vp-title").textContent = `単元${v.no}　${v.title}`;
  m.querySelector(".vp-meta").textContent = `${v.duration} ／ ${v.version}（${v.updated}）`;
  m.hidden = false;
  document.body.style.overflow = "hidden";
  m.querySelector(".vp-close").focus();
  await mountVideo(m.querySelector(".vp-body"), id, { autoplay: true });
}

export function closeVideoModal() {
  if (!modal || modal.hidden) return;
  const video = modal.querySelector("video");
  if (video) video.pause();
  modal.querySelector(".vp-body").innerHTML = "";
  modal.hidden = true;
  document.body.style.overflow = "";
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

/** <button data-video="U5"> の文言を目録から補い、クリックでモーダルを開く */
export function wireVideoButtons(root = document) {
  root.querySelectorAll("[data-video]").forEach((btn) => {
    const v = findVideo(btn.dataset.video);
    if (!v) { btn.hidden = true; return; }
    if (!btn.textContent.trim()) {
      btn.innerHTML = `<i class="ti ti-player-play" aria-hidden="true"></i> 動画で見る（単元${v.no}・${esc(v.duration)}）`;
    }
    btn.classList.add("vp-btn");
    btn.setAttribute("type", "button");
    btn.setAttribute("aria-label", `動画で見る: 単元${v.no} ${v.title}（${v.duration}）`);
    btn.addEventListener("click", () => openVideoModal(v.id));
  });
}

let styled = false;
function injectStyle() {
  if (styled) return;
  styled = true;
  const st = document.createElement("style");
  st.textContent = `
    .vp-btn{display:inline-flex;align-items:center;gap:6px;min-height:36px;padding:6px 12px;border-radius:8px;border:1px solid var(--color-line,#ddd);background:#fff;color:var(--color-primary,#c02828);font-size:13px;font-weight:600;cursor:pointer;margin:6px 0 2px}
    .vp-btn:hover{background:#fdf2f2}
    .vp-btn:focus-visible{outline:3px solid #c02828;outline-offset:2px}
    .vp-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px}
    .vp-box{background:#fff;border-radius:12px;width:min(960px,100%);max-height:96vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.3)}
    .vp-head{display:flex;align-items:flex-start;gap:12px;padding:14px 18px 10px;border-bottom:1px solid var(--color-line,#eee)}
    .vp-kicker{font-size:12px;color:var(--color-ink-muted,#7d715b)}
    .vp-title{font-size:16px;margin:2px 0 0;font-family:"Noto Serif JP",serif}
    .vp-close{margin-left:auto;width:44px;height:44px;border-radius:8px;border:1px solid var(--color-line,#ddd);background:#fff;cursor:pointer;font-size:18px}
    .vp-body{padding:12px 18px;background:#111}
    .vp-video{display:block;width:100%;max-height:70vh;background:#000;border-radius:6px}
    .vp-loading,.vp-error{color:#fff;font-size:13px;padding:40px 0;text-align:center}
    .vp-error{color:#ffd8d8}
    .vp-foot{display:flex;align-items:center;gap:12px;padding:10px 18px 14px;font-size:12.5px;color:var(--color-ink-muted,#7d715b)}
    .vp-all{margin-left:auto;display:inline-flex;align-items:center;gap:6px;min-height:44px;padding:0 12px;color:var(--color-primary,#c02828);text-decoration:none;font-weight:600}
    @media (max-width:1023px){.vp-box{max-height:100vh;border-radius:8px}.vp-body{padding:8px}}
  `;
  document.head.appendChild(st);
}

// ページ読み込み時に data-video ボタンを自動で結線（マニュアルページなど）
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => { injectStyle(); wireVideoButtons(); });
} else {
  injectStyle(); wireVideoButtons();
}

export { VIDEOS };
