// หน้าเว็บภาพกิจกรรม: #/ = รายการงาน, #/album/:id = ภาพในงาน
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");
const state = { user: null, list: { q: "", page: 1, albums: [], hasMore: false }, album: null, photos: [] };

const ICON = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  image: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M4 17l5-4.5 3.5 3 3-2.5L20 17"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>',
  user: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M12 16V4M7 9l5-5 5 5M4 16v2a3 3 0 003 3h10a3 3 0 003-3v-2"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12M9 7V4h6v3"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  login: '<svg viewBox="0 0 24 24"><path d="M14 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4M10 16l4-4-4-4M14 12H3"/></svg>',
  logout: '<svg viewBox="0 0 24 24"><path d="M10 4H6a2 2 0 00-2 2v12a2 2 0 002 2h4M15 16l4-4-4-4M19 12H9"/></svg>',
};

const MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const thaiDate = (iso) => { const [y, m, d] = String(iso).split("-").map(Number); return `${d} ${MONTHS[m - 1]} ${y + 543}`; };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, options = {}) {
  const init = { credentials: "same-origin", ...options, headers: { ...(options.headers || {}) } };
  if (init.body && !(init.body instanceof FormData)) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(init.body); }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || `เกิดข้อผิดพลาด (${res.status})`); e.status = res.status; throw e; }
  return data;
}

let toastTimer;
function toast(msg, error = false) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (error ? " error" : ""); t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

// ---------- กล่องโต้ตอบ ----------
const dialog = $("#dialog");
function openDialog(html, onSubmit) {
  const form = $("#dialogForm");
  form.innerHTML = html;
  dialog.showModal();
  $("input", form)?.focus();
  form.onsubmit = async (e) => {
    const action = e.submitter?.value;
    if (action === "cancel") return;
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    const err = $(".err", form); if (err) err.textContent = "";
    try { await onSubmit(new FormData(form)); dialog.close(); }
    catch (ex) { if (err) err.textContent = ex.message; else toast(ex.message, true); }
    finally { if (btn) btn.disabled = false; }
  };
}
const confirmBox = (title, text, okLabel = "ยืนยัน") => new Promise((resolve) => {
  openDialog(`<h2>${esc(title)}</h2><p class="hint">${esc(text)}</p><p class="err"></p>
    <div class="dlg-actions"><button class="btn ghost" value="cancel" formnovalidate>ยกเลิก</button><button class="btn danger" value="ok">${esc(okLabel)}</button></div>`,
  async () => resolve(true));
  dialog.addEventListener("close", () => resolve(false), { once: true });
});

function loginDialog() {
  openDialog(`<h2>เข้าสู่ระบบ</h2><p class="hint">ใช้บัญชีเดียวกับระบบ system.banpadengschool.ac.th</p>
    <label class="field">อีเมล<input name="email" type="email" autocomplete="username" required></label>
    <label class="field">รหัสผ่าน<input name="password" type="password" autocomplete="current-password" required></label>
    <p class="err"></p>
    <div class="dlg-actions"><button class="btn ghost" value="cancel" formnovalidate>ยกเลิก</button><button class="btn" value="ok">เข้าสู่ระบบ</button></div>`,
  async (fd) => {
    const { user } = await api("/api/login", { method: "POST", body: { email: fd.get("email"), password: fd.get("password") } });
    state.user = user; renderTop(); route(); toast(`ยินดีต้อนรับ ${user.full_name}`);
  });
}

function albumDialog(album) {
  const editing = !!album;
  openDialog(`<h2>${editing ? "แก้ไขชื่องาน" : "สร้างงานใหม่"}</h2>
    <p class="hint">${editing ? "ชื่อโฟลเดอร์ใน Drive จะเปลี่ยนตาม (วันที่เดิมคงไว้)" : "ระบบสร้างโฟลเดอร์ใน Drive ชื่อ “ชื่องาน (วันที่วันนี้)” ให้อัตโนมัติ"}</p>
    <label class="field">ชื่องาน<input name="title" maxlength="150" required value="${esc(album?.title || "")}" placeholder="เช่น กีฬาสีภายใน"></label>
    <p class="err"></p>
    <div class="dlg-actions"><button class="btn ghost" value="cancel" formnovalidate>ยกเลิก</button><button class="btn" value="ok">${editing ? "บันทึก" : "สร้างงาน"}</button></div>`,
  async (fd) => {
    const title = String(fd.get("title") || "").trim();
    if (editing) {
      await api(`/api/albums/${album.id}`, { method: "PATCH", body: { title } });
      toast("บันทึกแล้ว"); loadAlbum(album.id);
    } else {
      const res = await api("/api/albums", { method: "POST", body: { title } });
      toast("สร้างงานแล้ว เลือกภาพเพื่ออัพโหลดได้เลย");
      location.hash = `#/album/${res.album.id}`;
    }
  });
}

// ---------- แถบบน ----------
function renderTop() {
  const el = $("#topActions");
  if (state.user) {
    el.innerHTML = `<span class="who">${ICON.user} ${esc(state.user.full_name)}</span>
      <button class="btn ghost sm" id="logoutBtn" title="ออกจากระบบ">${ICON.logout}<span class="hide-sm">ออก</span></button>`;
    $("#logoutBtn").onclick = async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); state.user = null; renderTop(); route(); };
  } else {
    el.innerHTML = `<button class="btn ghost sm" id="loginBtn">${ICON.login} ครูเข้าสู่ระบบ</button>`;
    $("#loginBtn").onclick = loginDialog;
  }
}

// ---------- หน้ารายการงาน ----------
function albumCard(a) {
  const cover = a.cover_id ? `<img src="/img/${a.cover_id}/thumb" alt="" loading="lazy">` : ICON.image;
  return `<a class="album" href="#/album/${a.id}">
    <div class="cover">${cover}</div>
    <div class="album-body"><h3>${esc(a.title)}</h3>
      <div class="meta"><span>${ICON.calendar}${thaiDate(a.event_date)}</span><span>${ICON.image}${a.photo_count} ภาพ</span></div>
    </div></a>`;
}

async function loadList(append = false) {
  const { q, page } = state.list;
  const data = await api(`/api/albums?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  state.list.albums = append ? state.list.albums.concat(data.albums) : data.albums;
  state.list.hasMore = data.has_more;
  renderListBody();
}

function renderList() {
  app.innerHTML = `<section class="hero">
      <div><h1>ภาพกิจกรรมโรงเรียน</h1><p>รวมภาพกิจกรรมของโรงเรียนบ้านป่าเด็ง</p></div>
      <div class="tools">
        <label class="search">${ICON.search}<input id="q" type="search" placeholder="ค้นหาชื่องาน" value="${esc(state.list.q)}"></label>
        ${state.user ? `<button class="btn" id="newAlbum">${ICON.plus} สร้างงานใหม่</button>` : ""}
      </div>
    </section>
    <div id="listBody"><div class="empty">กำลังโหลด…</div></div>`;
  let t;
  $("#q").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { state.list.q = e.target.value.trim(); state.list.page = 1; loadList().catch((x) => toast(x.message, true)); }, 300); };
  if (state.user) $("#newAlbum").onclick = () => albumDialog(null);
  state.list.page = 1;
  loadList().catch((x) => { $("#listBody").innerHTML = `<div class="empty">${esc(x.message)}</div>`; });
}

function renderListBody() {
  const body = $("#listBody"); if (!body) return;
  const { albums, hasMore, q } = state.list;
  if (!albums.length) { body.innerHTML = `<div class="empty">${q ? "ไม่พบงานที่ค้นหา" : "ยังไม่มีภาพกิจกรรม"}</div>`; return; }
  body.innerHTML = `<div class="grid">${albums.map(albumCard).join("")}</div>
    ${hasMore ? `<div class="more"><button class="btn ghost" id="moreBtn">ดูเพิ่มเติม</button></div>` : ""}`;
  if (hasMore) $("#moreBtn").onclick = () => { state.list.page++; loadList(true).catch((x) => toast(x.message, true)); };
}

// ---------- หน้างาน ----------
async function loadAlbum(id) {
  try {
    const data = await api(`/api/albums/${id}`);
    state.album = data.album; state.photos = data.photos;
    renderAlbum();
  } catch (x) {
    app.innerHTML = `<a class="back" href="#/">${ICON.back} กลับหน้ารวม</a><div class="empty">${esc(x.message)}</div>`;
  }
}

const isAdmin = () => !!state.user?.is_admin;
const canManage = () => state.user && (isAdmin() || state.user.id === state.album.created_by);
const canDelete = (p) => state.user && (canManage() || state.user.id === p.uploaded_by);

function renderAlbum() {
  const a = state.album;
  const manage = canManage();
  const coverId = a.cover_photo_id || state.photos[0]?.id;
  app.innerHTML = `<a class="back" href="#/">${ICON.back} กลับหน้ารวม</a>
    <section class="album-head">
      <div><h1>${esc(a.title)}</h1>
        <div class="meta"><span>${ICON.calendar}${thaiDate(a.event_date)}</span><span>${ICON.image}${state.photos.length} ภาพ</span>${a.created_by_name ? `<span>${ICON.user}${esc(a.created_by_name)}</span>` : ""}</div></div>
      ${manage ? `<div class="tools"><button class="btn ghost sm" id="editAlbum">${ICON.edit} แก้ไขชื่อ</button><button class="btn danger sm" id="delAlbum">${ICON.trash} ลบงาน</button></div>` : ""}
    </section>
    ${state.user ? `<div class="dropzone" id="drop">${ICON.upload}<div><b>เลือกภาพ</b> หรือลากภาพมาวางที่นี่</div><small>JPG, PNG, WEBP, HEIC · ไม่เกิน 25 MB ต่อภาพ</small>
      <input id="files" type="file" accept="image/*" multiple hidden></div><div id="progress"></div>` : ""}
    ${state.photos.length ? `<div class="photos">${state.photos.map((p, i) => `
      <div class="photo" data-i="${i}" tabindex="0">
        <img src="/img/${p.id}/thumb" alt="${esc(p.file_name)}" loading="lazy">
        ${p.id === coverId ? `<span class="badge">ภาพปก</span>` : ""}
        ${state.user ? `<div class="ph-actions">
          ${manage && p.id !== coverId ? `<button data-cover="${p.id}" title="ตั้งเป็นภาพปก">${ICON.star}</button>` : ""}
          ${canDelete(p) ? `<button class="del" data-del="${p.id}" title="ลบภาพ">${ICON.trash}</button>` : ""}
        </div>` : ""}
      </div>`).join("")}</div>` : `<div class="empty">ยังไม่มีภาพในงานนี้</div>`}`;

  if (manage) {
    $("#editAlbum").onclick = () => albumDialog(a);
    $("#delAlbum").onclick = async () => {
      if (!await confirmBox("ลบงานนี้?", `ภาพทั้งหมด ${state.photos.length} ภาพและโฟลเดอร์ใน Drive จะถูกย้ายไปถังขยะ (กู้คืนใน Drive ได้ภายใน 30 วัน)`, "ลบงาน")) return;
      try { await api(`/api/albums/${a.id}`, { method: "DELETE" }); toast("ลบงานแล้ว"); location.hash = "#/"; }
      catch (x) { toast(x.message, true); }
    };
  }
  if (state.user) bindUpload();

  $(".photos")?.addEventListener("click", async (e) => {
    const cover = e.target.closest("[data-cover]"), del = e.target.closest("[data-del]");
    if (cover) {
      e.stopPropagation();
      try { await api(`/api/albums/${a.id}`, { method: "PATCH", body: { cover_photo_id: Number(cover.dataset.cover) } }); state.album.cover_photo_id = Number(cover.dataset.cover); renderAlbum(); toast("ตั้งภาพปกแล้ว"); }
      catch (x) { toast(x.message, true); }
      return;
    }
    if (del) {
      e.stopPropagation();
      if (!await confirmBox("ลบภาพนี้?", "ภาพจะถูกย้ายไปถังขยะใน Drive (กู้คืนได้ภายใน 30 วัน)", "ลบภาพ")) return;
      try { await api(`/api/photos/${del.dataset.del}`, { method: "DELETE" }); toast("ลบภาพแล้ว"); loadAlbum(a.id); }
      catch (x) { toast(x.message, true); }
      return;
    }
    const tile = e.target.closest(".photo");
    if (tile) openLightbox(Number(tile.dataset.i));
  });
}

// ---------- อัพโหลด (ทีละไฟล์ พร้อมกัน 3 ไฟล์) ----------
function bindUpload() {
  const drop = $("#drop"), input = $("#files");
  drop.onclick = () => input.click();
  input.onchange = () => { uploadFiles([...input.files]); input.value = ""; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles([...e.dataTransfer.files]); };
}

function uploadOne(albumId, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const fd = new FormData(); fd.append("file", file, file.name);
    xhr.open("POST", `/api/albums/${albumId}/photos`);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let data = {}; try { data = JSON.parse(xhr.responseText); } catch {}
      xhr.status < 300 ? resolve(data) : reject(new Error(data.error || `อัพโหลดไม่สำเร็จ (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("การเชื่อมต่อขัดข้อง"));
    xhr.send(fd);
  });
}

let uploading = false;
async function uploadFiles(files) {
  const images = files.filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  if (!images.length) return toast("กรุณาเลือกไฟล์ภาพ", true);
  if (uploading) return toast("กำลังอัพโหลดชุดก่อนหน้า กรุณารอสักครู่", true);
  uploading = true;
  const albumId = state.album.id;
  const box = $("#progress");
  const progress = new Array(images.length).fill(0);
  let done = 0; const failed = [];
  const paint = () => {
    const pct = Math.round(progress.reduce((s, v) => s + v, 0) / images.length * 100);
    box.innerHTML = `<div class="progress">กำลังอัพโหลด ${done}/${images.length} ภาพ${failed.length ? ` · ไม่สำเร็จ ${failed.length}` : ""}<div class="bar"><i style="width:${pct}%"></i></div></div>`;
  };
  paint();
  window.onbeforeunload = () => "กำลังอัพโหลดภาพ";
  let next = 0;
  const worker = async () => {
    while (next < images.length) {
      const i = next++;
      try { await uploadOne(albumId, images[i], (p) => { progress[i] = p; paint(); }); }
      catch (x) { failed.push(`${images[i].name}: ${x.message}`); }
      progress[i] = 1; done++; paint();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  window.onbeforeunload = null; uploading = false;
  if (failed.length) toast(`อัพโหลดไม่สำเร็จ ${failed.length} ภาพ — ${failed[0]}`, true);
  else toast(`อัพโหลดครบ ${images.length} ภาพแล้ว`);
  if (state.album?.id === albumId) loadAlbum(albumId);
}

// ---------- ดูภาพขนาดใหญ่ ----------
const lb = $("#lightbox"); let lbIndex = 0;
function openLightbox(i) { lbIndex = i; showLb(); lb.hidden = false; document.body.style.overflow = "hidden"; }
function closeLightbox() { lb.hidden = true; $("#lbImg").src = ""; document.body.style.overflow = ""; }
function showLb() {
  const p = state.photos[lbIndex]; if (!p) return;
  $("#lbImg").src = `/img/${p.id}/full`;
  $("#lbCount").textContent = `${lbIndex + 1} / ${state.photos.length}`;
  $("#lbDownload").href = `/img/${p.id}/full?download=1`;
}
const step = (d) => { lbIndex = (lbIndex + d + state.photos.length) % state.photos.length; showLb(); };
lb.addEventListener("click", (e) => {
  const b = e.target.closest("[data-lb]");
  if (b) ({ close: closeLightbox, prev: () => step(-1), next: () => step(1) })[b.dataset.lb]();
  else if (e.target === lb) closeLightbox();
});
document.addEventListener("keydown", (e) => {
  if (lb.hidden) return;
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});
let touchX = null;
lb.addEventListener("touchstart", (e) => { touchX = e.touches[0].clientX; }, { passive: true });
lb.addEventListener("touchend", (e) => { if (touchX == null) return; const dx = e.changedTouches[0].clientX - touchX; if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1); touchX = null; });

// ---------- เส้นทาง ----------
function route() {
  if (!lb.hidden) closeLightbox();
  const m = location.hash.match(/^#\/album\/(\d+)/);
  if (m) { app.innerHTML = `<div class="empty">กำลังโหลด…</div>`; loadAlbum(Number(m[1])); }
  else renderList();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

(async () => {
  try { state.user = (await api("/api/me")).user; } catch {}
  renderTop(); route();
})();
