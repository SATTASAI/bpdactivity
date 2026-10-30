// หน้าเว็บภาพกิจกรรม: #/ = รายการงาน, #/album/:id = ภาพในงาน
const $ = (sel, el = document) => el.querySelector(sel);
const app = $("#app");
$(".skip-link").onclick = (e) => { e.preventDefault(); app.focus(); };
const state = { selecting: false, selected: new Set(), user: null, list: { q: "", page: 1, albums: [], hasMore: false }, sidebar: { albums: [], page: 1, hasMore: false, loading: false }, album: null, photos: [], viewVersion: 0, listRequest: 0 };

// Feather icons (MIT), served locally without a third-party runtime dependency.
const icon = (name) => `<svg aria-hidden="true"><use href="/icons.svg#${name}"/></svg>`;
const ICON = Object.fromEntries(Object.entries({ search: "search", image: "image", calendar: "calendar", user: "user", plus: "plus", upload: "upload", edit: "edit-2", trash: "trash-2", star: "star", back: "chevron-left", login: "log-in", logout: "log-out", arrow: "arrow-right", download: "download", select: "check-square", folder: "folder" }).map(([key, name]) => [key, icon(name)]));

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
  openDialog(`<h2>${editing ? "แก้ไขอัลบั้ม" : "สร้างงานใหม่"}</h2>
    <p class="hint">${editing ? "ชื่อโฟลเดอร์ใน Drive จะเปลี่ยนตามชื่องานและวันที่" : "ระบบสร้างโฟลเดอร์ใน Drive ชื่อ “ชื่องาน (วันที่วันนี้)” ให้อัตโนมัติ"}</p>
    <label class="field">ชื่องาน<input name="title" maxlength="150" required value="${esc(album?.title || "")}" placeholder="เช่น กีฬาสีภายใน"></label>
    ${editing ? `<label class="field">วันที่จัดงาน<input name="event_date" type="date" required value="${esc(album.event_date)}"></label>
    <label class="field">คำอธิบายงาน<textarea name="description" rows="4" maxlength="2000" placeholder="รายละเอียดกิจกรรม (ไม่บังคับ)">${esc(album.description || "")}</textarea></label>` : ""}
    <p class="err"></p>
    <div class="dlg-actions"><button class="btn ghost" value="cancel" formnovalidate>ยกเลิก</button><button class="btn" value="ok">${editing ? "บันทึก" : "สร้างงาน"}</button></div>`,
  async (fd) => {
    const title = String(fd.get("title") || "").trim();
    if (editing) {
      await api(`/api/albums/${album.id}`, { method: "PATCH", body: { title, event_date: fd.get("event_date"), description: fd.get("description") } });
      toast("บันทึกแล้ว"); loadAlbum(album.id); loadSidebar();
    } else {
      const res = await api("/api/albums", { method: "POST", body: { title } });
      toast("สร้างงานแล้ว เลือกภาพเพื่ออัพโหลดได้เลย"); loadSidebar();
      location.hash = `#/album/${res.album.id}`;
    }
  });
}

// เลือกอัลบั้ม (ใช้ตอนอัพโหลดจากหน้ารวม และตอนย้ายภาพ)
async function albumOptionsHtml(excludeId) {
  const { albums } = await api("/api/album-options");
  return albums.filter((a) => a.id !== excludeId)
    .map((a) => `<option value="${a.id}">${esc(a.title)} · ${thaiDate(a.event_date)}</option>`).join("");
}

// อัพโหลดจากหน้ารวม: เลือกอัลบั้มเดิมหรือสร้างใหม่ + เลือกภาพ (ไม่จำกัดจำนวน)
async function quickUploadDialog() {
  if (!state.user) return loginDialog();
  let options = "";
  try { options = await albumOptionsHtml(); } catch (x) { return toast(x.message, true); }
  openDialog(`<h2>อัพโหลดภาพ</h2><p class="hint">สร้างงานใหม่หรือเลือกอัลบั้มเดิม แล้วเลือกภาพได้ไม่จำกัดจำนวน · งานใหม่จะได้โฟลเดอร์ “ชื่องาน (วันที่วันนี้)” ใน Google Drive</p>
    <div class="seg"><label><input type="radio" name="mode" value="new" checked> สร้างงานใหม่</label><label><input type="radio" name="mode" value="old"> อัลบั้มเดิม</label></div>
    <label class="field" data-mode="new">ชื่องาน<input name="title" maxlength="150" placeholder="เช่น กีฬาสีภายใน"></label>
    <label class="field" data-mode="old" hidden>อัลบั้ม<select name="album">${options}</select></label>
    <label class="field">ภาพ<input name="files" type="file" accept="image/*" multiple required></label>
    <p class="err"></p>
    <div class="dlg-actions"><button class="btn ghost" value="cancel" formnovalidate>ยกเลิก</button><button class="btn" value="ok">${ICON.upload} อัพโหลด</button></div>`,
  async (fd) => {
    const files = fd.getAll("files").filter((f) => f && f.size);
    if (!files.length) throw new Error("กรุณาเลือกภาพ");
    let albumId;
    if (fd.get("mode") === "old") {
      albumId = Number(fd.get("album"));
      if (!albumId) throw new Error("กรุณาเลือกอัลบั้ม");
    } else {
      const title = String(fd.get("title") || "").trim();
      if (!title) throw new Error("กรุณากรอกชื่องาน");
      albumId = (await api("/api/albums", { method: "POST", body: { title } })).album.id;
    }
    location.hash = `#/album/${albumId}`;
    uploadFiles(files, albumId);
  });
  const form = $("#dialogForm");
  form.querySelectorAll('input[name="mode"]').forEach((r) => r.onchange = () => {
    const mode = form.querySelector('input[name="mode"]:checked').value;
    form.querySelectorAll("[data-mode]").forEach((el) => { el.hidden = el.dataset.mode !== mode; });
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

// ---------- เมนูอัลบั้ม ----------
const layout = $("#layout"), sidebar = $("#albumSidebar");
const narrowScreen = window.matchMedia("(max-width: 760px)");
let collapsed = false;
try { collapsed = localStorage.getItem("activity.sidebar.collapsed") === "true"; } catch {}
let mobileOpen = false;
function updateSidebarLayout() {
  layout.classList.toggle("sidebar-collapsed", collapsed && !narrowScreen.matches);
  layout.classList.toggle("sidebar-open", mobileOpen && narrowScreen.matches);
  document.body.classList.toggle("menu-open", mobileOpen && narrowScreen.matches);
  sidebar.inert = narrowScreen.matches && !mobileOpen;
  app.inert = narrowScreen.matches && mobileOpen;
  $("#topActions").inert = narrowScreen.matches && mobileOpen;
  $("#sidebarScrim").hidden = !mobileOpen || !narrowScreen.matches;
  $("#mobileMenu").setAttribute("aria-expanded", String(mobileOpen && narrowScreen.matches));
  const expanded = narrowScreen.matches ? mobileOpen : !collapsed;
  $("#sidebarToggle").setAttribute("aria-expanded", String(expanded));
  $("#sidebarToggle").setAttribute("aria-label", expanded ? "ยุบเมนูอัลบั้ม" : "ขยายเมนูอัลบั้ม");
  $("#sidebarToggle").title = expanded ? "ยุบเมนูอัลบั้ม" : "ขยายเมนูอัลบั้ม";
  $("#sidebarCollapse").setAttribute("aria-label", expanded ? "ยุบเมนูอัลบั้ม" : "ขยายเมนูอัลบั้ม");
  $("#sidebarCollapse span").textContent = expanded ? "ยุบแถบเมนู" : "ขยายแถบเมนู";
}
function closeMobileMenu(restoreFocus = false) {
  mobileOpen = false; updateSidebarLayout();
  if (restoreFocus && narrowScreen.matches) $("#mobileMenu").focus();
}
function toggleSidebar() {
  if (narrowScreen.matches) closeMobileMenu(true);
  else {
    collapsed = !collapsed;
    try { localStorage.setItem("activity.sidebar.collapsed", String(collapsed)); } catch {}
    updateSidebarLayout();
    $("#sidebarToggle").focus();
  }
}
$("#sidebarToggle").onclick = toggleSidebar;
$("#sidebarCollapse").onclick = toggleSidebar;
$("#mobileMenu").onclick = () => {
  mobileOpen = !mobileOpen; updateSidebarLayout();
  if (mobileOpen) $("#sidebarToggle").focus();
};
$("#sidebarScrim").onclick = () => closeMobileMenu(true);
narrowScreen.addEventListener("change", () => { mobileOpen = false; updateSidebarLayout(); });
sidebar.addEventListener("click", (e) => { if (e.target.closest("a")) closeMobileMenu(); });
updateSidebarLayout();

function renderSidebar() {
  const { albums, hasMore, loading } = state.sidebar;
  const selected = location.hash.match(/^#\/album\/(\d+)$/)?.[1];
  const all = $(".nav-all");
  all.classList.toggle("selected", !selected);
  if (!selected) all.setAttribute("aria-current", "page"); else all.removeAttribute("aria-current");
  $("#sidebarAlbums").innerHTML = albums.map(a => `<a class="sidebar-album${String(a.id) === selected ? " selected" : ""}" href="#/album/${a.id}" ${String(a.id) === selected ? 'aria-current="page"' : ""} title="${esc(a.title)}">
      <span class="sidebar-thumb">${a.cover_id ? `<img src="/img/${a.cover_id}/thumb" alt="" loading="lazy">` : ICON.image}</span>
      <span class="sidebar-album-info"><b>${esc(a.title)}</b><small>${thaiDate(a.event_date)}</small><small>${ICON.image}${a.photo_count} ภาพ</small></span>
    </a>`).join("") + (!albums.length ? `<p class="sidebar-message">${loading ? "กำลังโหลด…" : "ยังไม่มีอัลบั้ม"}</p>` : "") +
    (hasMore ? `<button class="sidebar-more" id="sidebarMore" ${loading ? "disabled" : ""}>${loading ? "กำลังโหลด…" : "ดูอัลบั้มเพิ่มเติม"}</button>` : "");
  if ($("#sidebarMore")) $("#sidebarMore").onclick = () => loadSidebar(true);
}
let sidebarRequest = 0;
async function loadSidebar(append = false) {
  const request = ++sidebarRequest;
  const page = append ? state.sidebar.page + 1 : 1;
  state.sidebar.loading = true; renderSidebar();
  try {
    const data = await api(`/api/albums?page=${page}`);
    if (request !== sidebarRequest) return;
    state.sidebar.albums = append ? state.sidebar.albums.concat(data.albums) : data.albums;
    state.sidebar.page = page; state.sidebar.hasMore = data.has_more;
    state.sidebar.loading = false; renderSidebar();
  } catch (x) {
    if (request !== sidebarRequest) return;
    state.sidebar.loading = false;
    renderSidebar();
    const error = document.createElement("p"); error.className = "sidebar-message"; error.textContent = x.message;
    const retry = document.createElement("button"); retry.className = "sidebar-more"; retry.textContent = "ลองอีกครั้ง";
    retry.onclick = () => loadSidebar(append);
    if (!state.sidebar.albums.length) $("#sidebarAlbums").replaceChildren();
    $("#sidebarAlbums").append(error, retry);
  }
}

// ---------- หน้ารายการงาน ----------
function albumMeta(a) {
  return `<div class="meta"><span>${ICON.calendar}${thaiDate(a.event_date)}</span><span>${ICON.image}${a.photo_count} ภาพ</span></div>`;
}
function albumCard(a) {
  const cover = a.cover_id ? `<img src="/img/${a.cover_id}/thumb" alt="" loading="lazy">` : ICON.image;
  return `<a class="album" href="#/album/${a.id}">
    <div class="cover">${cover}</div>
    <div class="album-body"><h3>${esc(a.title)}</h3>${albumMeta(a)}</div></a>`;
}
function featuredAlbum(a) {
  return `<a class="featured" href="#/album/${a.id}">
    <div class="featured-cover">${a.cover_id ? `<img src="/img/${a.cover_id}/thumb" alt="" fetchpriority="high">` : ICON.image}</div>
    <div class="featured-copy"><span class="eyebrow">อัลบั้มล่าสุด</span><h2>${esc(a.title)}</h2><p>บันทึกภาพกิจกรรมและความทรงจำของโรงเรียนบ้านป่าเด็ง</p>
      <div class="featured-bottom">${albumMeta(a)}<span class="album-open" aria-label="ดูอัลบั้ม">${ICON.arrow}</span></div>
    </div></a>`;
}
async function loadList(append = false) {
  const { q } = state.list;
  const page = append ? state.list.page + 1 : 1;
  const view = state.viewVersion, request = ++state.listRequest;
  const data = await api(`/api/albums?page=${page}${q ? `&q=${encodeURIComponent(q)}` : ""}`);
  if (view !== state.viewVersion || request !== state.listRequest) return;
  state.list.albums = append ? state.list.albums.concat(data.albums) : data.albums;
  state.list.page = page; state.list.hasMore = data.has_more;
  renderListBody();
}
function renderList() {
  state.album = null;
  app.innerHTML = `<section class="hero">
      <div><h1>ภาพกิจกรรมโรงเรียน</h1><p>รวมภาพกิจกรรมของโรงเรียนบ้านป่าเด็ง</p></div>
      <div class="tools"><label class="search">${ICON.search}<input id="q" type="search" aria-label="ค้นหาชื่องาน" placeholder="ค้นหาชื่องาน" value="${esc(state.list.q)}"></label>
        <button class="btn" id="quickUpload">${ICON.upload} อัพโหลดภาพ</button></div>
    </section>
    <div id="listBody" aria-busy="true"><div class="empty" role="status">กำลังโหลด…</div></div>
    <footer class="page-footer">ภาพกิจกรรม · โรงเรียนบ้านป่าเด็ง</footer>`;
  let t;
  const view = state.viewVersion;
  $("#q").oninput = (e) => {
    clearTimeout(t); state.list.q = e.target.value.trim(); ++state.listRequest;
    $("#listBody").setAttribute("aria-busy", "true");
    t = setTimeout(() => { if (view === state.viewVersion) loadList().catch(x => {
      if (view === state.viewVersion) { $("#listBody").setAttribute("aria-busy", "false"); toast(x.message, true); }
    }); }, 300);
  };
  $("#quickUpload").onclick = quickUploadDialog;
  loadList().catch((x) => {
    if (view !== state.viewVersion) return;
    $("#listBody").setAttribute("aria-busy", "false");
    $("#listBody").innerHTML = `<div class="empty" role="status">${esc(x.message)}<button class="btn ghost" id="retryList">ลองอีกครั้ง</button></div>`;
    $("#retryList").onclick = renderList;
  });
}
function renderListBody() {
  const body = $("#listBody"); if (!body) return;
  const { albums, hasMore, q } = state.list;
  body.setAttribute("aria-busy", "false");
  if (!albums.length) {
    body.innerHTML = `<div class="empty" role="status">${ICON.image}<h2>${q ? "ไม่พบงานที่ค้นหา" : "ยังไม่มีภาพกิจกรรม"}</h2><p>${q ? "ลองค้นหาด้วยชื่อกิจกรรมอื่น" : "เมื่อครูเพิ่มอัลบั้ม ภาพกิจกรรมจะแสดงที่นี่"}</p></div>`;
    return;
  }
  const otherAlbums = q ? albums : albums.slice(1);
  body.innerHTML = `${!q ? featuredAlbum(albums[0]) : ""}${otherAlbums.length ? `<section class="album-section" aria-label="${q ? "ผลการค้นหา" : "อัลบั้มทั้งหมด"}">
    <h2 class="section-title">${q ? "ผลการค้นหา" : "อัลบั้มทั้งหมด"}</h2><div class="grid">${otherAlbums.map(albumCard).join("")}</div></section>` : ""}
    ${hasMore ? `<div class="more"><button class="btn ghost" id="moreBtn">ดูเพิ่มเติม</button></div>` : ""}`;
  if (hasMore) $("#moreBtn").onclick = async (e) => {
    e.currentTarget.disabled = true;
    try { await loadList(true); } catch (x) { if ($("#moreBtn")) $("#moreBtn").disabled = false; toast(x.message, true); }
  };
}

// ---------- หน้างาน ----------
async function loadAlbum(id) {
  const view = state.viewVersion;
  try {
    const data = await api(`/api/albums/${id}`);
    if (view !== state.viewVersion) return;
    state.album = data.album; state.photos = data.photos;
    renderAlbum();
  } catch (x) {
    if (view !== state.viewVersion) return;
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
  const selectable = state.photos.filter(canDelete);
  if (!selectable.length) state.selecting = false;
  const sel = state.selected;
  app.innerHTML = `<a class="back" href="#/">${ICON.back} กลับหน้ารวม</a>
    <section class="album-head">
      <div><h1>${esc(a.title)}</h1>
        <div class="meta"><span>${ICON.calendar}${thaiDate(a.event_date)}</span><span>${ICON.image}${state.photos.length} ภาพ</span>${a.created_by_name ? `<span>${ICON.user}${esc(a.created_by_name)}</span>` : ""}</div>
        ${a.description ? `<p class="album-desc">${esc(a.description)}</p>` : ""}</div>
      <div class="tools">
        ${state.photos.length ? `<button class="btn ghost sm" id="dlAlbum">${ICON.download} ดาวน์โหลดอัลบั้ม</button>` : ""}
        ${selectable.length ? `<button class="btn ghost sm${state.selecting ? " on" : ""}" id="selectMode">${ICON.select} ${state.selecting ? "เลิกเลือก" : "เลือกภาพ"}</button>` : ""}
        ${manage ? `<button class="btn ghost sm" id="editAlbum">${ICON.edit} แก้ไขอัลบั้ม</button><button class="btn danger sm" id="delAlbum">${ICON.trash} ลบงาน</button>` : ""}
      </div>
    </section>
    ${state.selecting ? `<div class="select-bar" role="toolbar" aria-label="จัดการภาพที่เลือก">
      <span><b id="selCount">${sel.size}</b> ภาพที่เลือก</span>
      <button class="btn ghost sm" id="selAll">${sel.size === selectable.length ? "ไม่เลือกทั้งหมด" : "เลือกทั้งหมด"}</button>
      <button class="btn ghost sm" id="selMove" ${sel.size ? "" : "disabled"}>${ICON.folder} ย้ายไปอัลบั้มอื่น</button>
      <button class="btn danger sm" id="selDelete" ${sel.size ? "" : "disabled"}>${ICON.trash} ลบที่เลือก</button>
    </div>` : ""}
    ${state.user ? `<div class="dropzone" id="drop">${ICON.upload}<div><b>เลือกภาพ</b> หรือลากภาพมาวางที่นี่ (เลือกได้ไม่จำกัดจำนวน)</div><small>JPG, PNG, WEBP, HEIC · ไม่เกิน 25 MB ต่อภาพ</small>
      <input id="files" type="file" accept="image/*" multiple hidden></div><div id="progress"></div>` : ""}
    ${state.photos.length ? `<div class="photos${state.selecting ? " selecting" : ""}">${state.photos.map((p, i) => `
      <div class="photo${sel.has(p.id) ? " picked" : ""}${state.selecting && !canDelete(p) ? " locked" : ""}" data-i="${i}" data-id="${p.id}" tabindex="0" role="button" aria-label="${state.selecting ? "เลือก" : "ดู"}ภาพ ${i + 1}: ${esc(p.file_name)}"${state.selecting ? ` aria-pressed="${sel.has(p.id)}"` : ""}>
        <img src="/img/${p.id}/thumb" alt="${esc(p.file_name)}" loading="lazy">
        ${state.selecting && canDelete(p) ? `<span class="tick" aria-hidden="true">${sel.has(p.id) ? "✓" : ""}</span>` : ""}
        ${p.id === coverId && !state.selecting ? `<span class="badge">ภาพปก</span>` : ""}
        ${state.user && !state.selecting ? `<div class="ph-actions">
          ${manage && p.id !== coverId ? `<button data-cover="${p.id}" title="ตั้งเป็นภาพปก">${ICON.star}</button>` : ""}
          ${canDelete(p) ? `<button class="del" data-del="${p.id}" title="ลบภาพ">${ICON.trash}</button>` : ""}
        </div>` : ""}
      </div>`).join("")}</div>` : `<div class="empty">ยังไม่มีภาพในงานนี้</div>`}`;

  if ($("#dlAlbum")) $("#dlAlbum").onclick = () => downloadAlbum(a);
  if ($("#selectMode")) $("#selectMode").onclick = () => { state.selecting = !state.selecting; state.selected.clear(); renderAlbum(); };
  if (state.selecting) {
    $("#selAll").onclick = () => {
      if (sel.size === selectable.length) sel.clear(); else selectable.forEach((p) => sel.add(p.id));
      renderAlbum();
    };
    $("#selDelete").onclick = async () => {
      const ids = [...sel];
      if (!await confirmBox(`ลบ ${ids.length} ภาพ?`, "ภาพจะถูกย้ายไปถังขยะใน Drive (กู้คืนได้ภายใน 30 วัน)", "ลบภาพ")) return;
      await bulkAction("/api/photos/delete", { ids }, (r) => `ลบแล้ว ${r.deleted} ภาพ`);
    };
    $("#selMove").onclick = () => moveDialog([...sel]);
  }
  if (manage) {
    $("#editAlbum").onclick = () => albumDialog(a);
    $("#delAlbum").onclick = async () => {
      if (!await confirmBox("ลบงานนี้?", `ภาพทั้งหมด ${state.photos.length} ภาพและโฟลเดอร์ใน Drive จะถูกย้ายไปถังขยะ (กู้คืนใน Drive ได้ภายใน 30 วัน)`, "ลบงาน")) return;
      try { await api(`/api/albums/${a.id}`, { method: "DELETE" }); toast("ลบงานแล้ว"); loadSidebar(); location.hash = "#/"; }
      catch (x) { toast(x.message, true); }
    };
  }
  if (state.user) bindUpload();

  $(".photos")?.addEventListener("click", async (e) => {
    const tile = e.target.closest(".photo");
    if (state.selecting) {
      if (!tile) return;
      const id = Number(tile.dataset.id), p = state.photos[Number(tile.dataset.i)];
      if (!canDelete(p)) return toast("เลือกได้เฉพาะภาพที่คุณมีสิทธิ์จัดการ", true);
      sel.has(id) ? sel.delete(id) : sel.add(id);
      renderAlbum();
      $(`.photo[data-id="${id}"]`)?.focus();
      return;
    }
    const cover = e.target.closest("[data-cover]"), del = e.target.closest("[data-del]");
    if (cover) {
      e.stopPropagation();
      try { await api(`/api/albums/${a.id}`, { method: "PATCH", body: { cover_photo_id: Number(cover.dataset.cover) } }); state.album.cover_photo_id = Number(cover.dataset.cover); renderAlbum(); loadSidebar(); toast("ตั้งภาพปกแล้ว"); }
      catch (x) { toast(x.message, true); }
      return;
    }
    if (del) {
      e.stopPropagation();
      if (!await confirmBox("ลบภาพนี้?", "ภาพจะถูกย้ายไปถังขยะใน Drive (กู้คืนได้ภายใน 30 วัน)", "ลบภาพ")) return;
      try { await api(`/api/photos/${del.dataset.del}`, { method: "DELETE" }); toast("ลบภาพแล้ว"); loadAlbum(a.id); loadSidebar(); }
      catch (x) { toast(x.message, true); }
      return;
    }
    if (tile) openLightbox(Number(tile.dataset.i));
  });
}

async function bulkAction(path, body, okText) {
  try {
    const r = await api(path, { method: "POST", body });
    toast(r.failed ? `${okText(r)} · ไม่สำเร็จ ${r.failed} ภาพ${r.error ? ` (${r.error})` : ""}` : okText(r), !!r.failed);
  } catch (x) { toast(x.message, true); }
  state.selecting = false; state.selected.clear();
  loadAlbum(state.album.id); loadSidebar();
}

async function moveDialog(ids) {
  let options = "";
  try { options = await albumOptionsHtml(state.album.id); } catch (x) { return toast(x.message, true); }
  if (!options) return toast("ยังไม่มีอัลบั้มอื่นให้ย้ายไป", true);
  openDialog(`<h2>ย้าย ${ids.length} ภาพ</h2><p class="hint">ไฟล์ใน Google Drive จะย้ายไปโฟลเดอร์ของอัลบั้มปลายทางด้วย</p>
    <label class="field">ย้ายไปอัลบั้ม<select name="album" required>${options}</select></label>
    <p class="err"></p>
    <div class="dlg-actions"><button class="btn ghost" value="cancel" formnovalidate>ยกเลิก</button><button class="btn" value="ok">${ICON.folder} ย้ายภาพ</button></div>`,
  async (fd) => { await bulkAction("/api/photos/move", { ids, album_id: Number(fd.get("album")) }, (r) => `ย้ายแล้ว ${r.moved} ภาพ`); });
}

// ดาวน์โหลดทั้งอัลบั้มเป็น .zip (อัลบั้มใหญ่แบ่งเป็นหลายไฟล์)
const sizeText = (b) => b >= 1073741824 ? `${(b / 1073741824).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1048576))} MB`;
async function downloadAlbum(a) {
  try {
    const { parts } = await api(`/api/albums/${a.id}/download`);
    if (!parts.length) return toast("ยังไม่มีภาพในอัลบั้มนี้", true);
    if (parts.length === 1) { location.href = parts[0].url; return toast("เริ่มดาวน์โหลดแล้ว อัลบั้มใหญ่อาจใช้เวลาสักครู่"); }
    openDialog(`<h2>ดาวน์โหลดอัลบั้ม</h2><p class="hint">อัลบั้มนี้ใหญ่ จึงแบ่งเป็น ${parts.length} ไฟล์ — กดดาวน์โหลดทีละไฟล์</p>
      <div class="dl-parts">${parts.map((p) => `<a class="btn ghost" href="${p.url}">${ICON.download} ส่วนที่ ${p.part} · ${p.count} ภาพ · ~${sizeText(p.bytes)}</a>`).join("")}</div>
      <div class="dlg-actions"><button class="btn ghost" value="cancel" formnovalidate>ปิด</button></div>`, async () => {});
  } catch (x) { toast(x.message, true); }
}

// ---------- อัพโหลด (ทีละไฟล์ พร้อมกัน 3 ไฟล์) ----------
function bindUpload() {
  const drop = $("#drop"), input = $("#files");
  drop.onclick = () => input.click();
  input.onchange = () => { uploadFiles([...input.files], state.album.id); input.value = ""; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles([...e.dataTransfer.files], state.album.id); };
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
async function uploadFiles(files, albumId) {
  const images = files.filter((f) => f.type.startsWith("image/") || /\.(heic|heif)$/i.test(f.name));
  if (!images.length) return toast("กรุณาเลือกไฟล์ภาพ", true);
  if (uploading) return toast("กำลังอัพโหลดชุดก่อนหน้า กรุณารอสักครู่", true);
  uploading = true;
  const progress = new Array(images.length).fill(0);
  let done = 0; const failed = [];
  const paint = () => {
    const pct = Math.round(progress.reduce((s, v) => s + v, 0) / images.length * 100);
    const box = $("#progress"); if (!box || state.album?.id !== albumId) return;
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
  loadSidebar();
}

// ---------- ดูภาพขนาดใหญ่ ----------
const lb = $("#lightbox"); let lbIndex = 0, lbOpener = null;
let previousOverflow = "";
function openLightbox(i) {
  if (!state.photos[i]) return;
  lbIndex = i; lbOpener = document.activeElement;
  previousOverflow = document.body.style.overflow;
  lb.hidden = false; document.body.style.overflow = "hidden";
  layout.inert = true; $(".topbar").inert = true;
  showLb(); $(".lb-close").focus();
}
function closeLightbox() {
  lb.hidden = true;
  const img = $("#lbImg"); img.onload = img.onerror = null; img.removeAttribute("src");
  layout.inert = false; $(".topbar").inert = false;
  document.body.style.overflow = previousOverflow;
  if (lbOpener?.isConnected) lbOpener.focus();
}
function showLb() {
  const p = state.photos[lbIndex]; if (!p) return;
  const img = $("#lbImg"), status = $("#lbStatus");
  img.hidden = true; img.alt = p.file_name || `ภาพที่ ${lbIndex + 1}`;
  status.hidden = false; status.textContent = "กำลังโหลดภาพ…";
  lb.setAttribute("aria-busy", "true");
  img.onload = () => { img.hidden = false; status.hidden = true; lb.setAttribute("aria-busy", "false"); };
  img.onerror = () => { status.textContent = "โหลดภาพไม่สำเร็จ ลองเปิดภาพนี้อีกครั้ง"; lb.setAttribute("aria-busy", "false"); };
  img.src = `/img/${p.id}/full`;
  $("#lbCount").textContent = `${lbIndex + 1} / ${state.photos.length}`;
  $("#lbName").textContent = p.file_name;
  $("#lbDownload").href = `/img/${p.id}/full?download=1`;
  $(".lb-prev").hidden = $(".lb-next").hidden = state.photos.length < 2;
}
const step = (d) => {
  if (state.photos.length < 2) return;
  lbIndex = (lbIndex + d + state.photos.length) % state.photos.length; showLb();
};
lb.addEventListener("click", (e) => {
  const b = e.target.closest("[data-lb]");
  if (b) ({ close: closeLightbox, prev: () => step(-1), next: () => step(1) })[b.dataset.lb]();
  else if (e.target === lb) closeLightbox();
});
app.addEventListener("keydown", (e) => {
  const tile = e.target.closest(".photo");
  if (tile && e.target === tile && (e.key === "Enter" || e.key === " ")) {
    e.preventDefault(); openLightbox(Number(tile.dataset.i));
  }
});
function trapTab(e, root) {
  const controls = [...root.querySelectorAll('button, a[href], input, [tabindex="0"]')].filter(el => !el.hidden && !el.disabled && el.getClientRects().length);
  const first = controls[0], last = controls.at(-1);
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
document.addEventListener("keydown", (e) => {
  if (lb.hidden) {
    if (mobileOpen && narrowScreen.matches) {
      if (e.key === "Escape") { e.preventDefault(); closeMobileMenu(true); }
      if (e.key === "Tab") trapTab(e, sidebar);
    }
    return;
  }
  if (["Escape", "ArrowLeft", "ArrowRight"].includes(e.key)) e.preventDefault();
  if (e.key === "Escape") closeLightbox();
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
  if (e.key === "Tab") trapTab(e, lb);
});
let touch = null;
lb.addEventListener("touchstart", (e) => {
  touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
lb.addEventListener("touchend", (e) => {
  if (!touch || e.touches.length) { touch = null; return; }
  const dx = e.changedTouches[0].clientX - touch.x, dy = e.changedTouches[0].clientY - touch.y;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) step(dx < 0 ? 1 : -1);
  touch = null;
}, { passive: true });
lb.addEventListener("touchcancel", () => { touch = null; }, { passive: true });

// ---------- เส้นทาง ----------
function route() {
  ++state.viewVersion;
  state.selecting = false; state.selected.clear();
  if (!lb.hidden) closeLightbox();
  const m = location.hash.match(/^#\/album\/(\d+)/);
  if (m) { app.innerHTML = `<div class="empty">กำลังโหลด…</div>`; loadAlbum(Number(m[1])); }
  else renderList();
  closeMobileMenu(); renderSidebar();
  window.scrollTo(0, 0);
}
window.addEventListener("hashchange", route);

(async () => {
  try { state.user = (await api("/api/me")).user; } catch {}
  renderTop(); route(); loadSidebar();
})();

