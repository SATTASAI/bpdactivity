// ระบบภาพกิจกรรมโรงเรียนบ้านป่าเด็ง (activity.banpadengschool.ac.th)
// - ทุกคนดูภาพได้ (สาธารณะ) · ครูล็อกอินด้วยบัญชีเดียวกับ system เพื่ออัพโหลด/แก้ไข/ลบ
// - ภาพเก็บใน Google Drive: โฟลเดอร์ "ชื่องาน (30 ต.ค. 2569)" ใต้ ACTIVITY_DRIVE_FOLDER_ID
import { verifyPassword, signJWT, verifyJWT, buildSessionCookie, buildClearCookie, AUTH_COOKIE_NAME } from "./crypto.js";
import * as drive from "./drive.js";
import { runSync } from "./sync.js";

const ROLES = ["teacher", "executive", "staff", "superadmin"];
const ADMIN_ROLES = ["superadmin", "executive"];
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif"];
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const PAGE_SIZE = 24;
const THUMB_SIZE = 600;

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers },
  });
}
const fail = (error, status = 400) => json({ error }, status);

// ---------- ฐานข้อมูล (ใช้ D1 ร่วมกับ system; ตารางขึ้นต้นด้วย activity_) ----------
// created_by / uploaded_by เป็น NULL ได้ = อัลบั้ม/ภาพที่ซิงก์มาจาก Drive (source = 'drive')
const ALBUMS_DDL = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  drive_folder_id TEXT NOT NULL,
  cover_photo_id INTEGER,
  created_by INTEGER,
  source TEXT NOT NULL DEFAULT 'web',
  synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by INTEGER)`;
const PHOTOS_DDL = (name) => `CREATE TABLE IF NOT EXISTS ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id INTEGER NOT NULL,
  drive_file_id TEXT NOT NULL,
  drive_parent_id TEXT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  width INTEGER,
  height INTEGER,
  uploaded_by INTEGER,
  source TEXT NOT NULL DEFAULT 'web',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  deleted_by INTEGER)`;

// ตารางรุ่นแรก (created_by NOT NULL) → สร้างใหม่ตามโครงสร้างปัจจุบัน แล้วคัดลอกข้อมูลเดิม
async function migrateV1(env) {
  const cols = (await env.DB.prepare("PRAGMA table_info(activity_albums)").all()).results || [];
  const createdBy = cols.find((c) => c.name === "created_by");
  if (!createdBy || (Number(createdBy.notnull) === 0 && cols.some((c) => c.name === "source"))) return;
  await env.DB.batch([
    env.DB.prepare(ALBUMS_DDL("activity_albums_v2")),
    env.DB.prepare(`INSERT INTO activity_albums_v2 (id, title, event_date, folder_name, drive_folder_id, cover_photo_id, created_by, created_at, updated_at, deleted_at, deleted_by)
      SELECT id, title, event_date, folder_name, drive_folder_id, cover_photo_id, created_by, created_at, updated_at, deleted_at, deleted_by FROM activity_albums`),
    env.DB.prepare(PHOTOS_DDL("activity_photos_v2")),
    env.DB.prepare(`INSERT INTO activity_photos_v2 (id, album_id, drive_file_id, file_name, mime_type, file_size, width, height, uploaded_by, created_at, deleted_at, deleted_by)
      SELECT id, album_id, drive_file_id, file_name, mime_type, file_size, width, height, uploaded_by, created_at, deleted_at, deleted_by FROM activity_photos`),
    env.DB.prepare("DROP TABLE activity_photos"),
    env.DB.prepare("DROP TABLE activity_albums"),
    env.DB.prepare("ALTER TABLE activity_albums_v2 RENAME TO activity_albums"),
    env.DB.prepare("ALTER TABLE activity_photos_v2 RENAME TO activity_photos"),
    env.DB.prepare("UPDATE activity_photos SET drive_parent_id = (SELECT drive_folder_id FROM activity_albums a WHERE a.id = activity_photos.album_id)"),
  ]);
}

let schemaReady = false;
export async function ensureSchema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(ALBUMS_DDL("activity_albums")),
    env.DB.prepare(PHOTOS_DDL("activity_photos")),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS activity_login_failures (
      email TEXT NOT NULL, ip TEXT, at TEXT NOT NULL DEFAULT (datetime('now')))`),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS activity_sync_state (key TEXT PRIMARY KEY, value TEXT)"),
  ]);
  await migrateV1(env);
  await env.DB.batch([
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_activity_albums_date ON activity_albums(deleted_at, event_date, id)"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_albums_folder ON activity_albums(drive_folder_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_activity_photos_album ON activity_photos(album_id, deleted_at, id)"),
    env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_photos_file ON activity_photos(drive_file_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_activity_photos_parent ON activity_photos(drive_parent_id)"),
    env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_activity_login_failures ON activity_login_failures(email, at)"),
  ]);
  schemaReady = true;
}

// ---------- ผู้ใช้ ----------
function readCookie(request, name) {
  for (const part of (request.headers.get("Cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

async function isViewerAccount(env, userId) {
  try {
    return !!(await env.DB.prepare("SELECT 1 FROM viewer_accounts WHERE user_id = ?").bind(userId).first());
  } catch { return false; } // ไม่มีตาราง = ไม่มีบัญชีผู้ชมภายนอก
}

function canUse(user) {
  return user && user.status === "active" && !user.deleted_at && ROLES.includes(user.role);
}

async function currentUser(request, env) {
  const payload = await verifyJWT(readCookie(request, AUTH_COOKIE_NAME), env.JWT_SECRET);
  if (!payload?.sub || payload.app !== "activity") return null;
  const user = await env.DB.prepare("SELECT id, email, full_name, role, status, session_version, deleted_at FROM users WHERE id = ?")
    .bind(payload.sub).first().catch(() => null);
  if (!canUse(user)) return null;
  // เปลี่ยนรหัสผ่าน/ออกจากทุกอุปกรณ์ใน system → session ที่นี่หมดอายุด้วย
  if (user.session_version != null && Number(payload.sv || 1) !== Number(user.session_version)) return null;
  if (await isViewerAccount(env, user.id)) return null;
  return { id: user.id, email: user.email, full_name: user.full_name, role: user.role, is_admin: ADMIN_ROLES.includes(user.role) };
}

const canManageAlbum = (user, album) => user.is_admin || Number(album.created_by) === Number(user.id);
const canDeletePhoto = (user, album, photo) => canManageAlbum(user, album) || Number(photo.uploaded_by) === Number(user.id);

async function login(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return fail("กรุณากรอกอีเมลและรหัสผ่าน");
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM activity_login_failures WHERE email = ? AND at > datetime('now','-15 minutes')").bind(email).first();
  if (n >= 8) return fail("ลองเข้าสู่ระบบผิดหลายครั้ง กรุณารอ 15 นาที", 429);

  const user = await env.DB.prepare("SELECT id, email, full_name, role, status, password_hash, password_salt, session_version, deleted_at FROM users WHERE lower(email) = ?")
    .bind(email).first();
  const ok = user && await verifyPassword(password, user.password_salt, user.password_hash);
  if (!ok) {
    await env.DB.prepare("INSERT INTO activity_login_failures (email, ip) VALUES (?, ?)").bind(email, ip).run();
    return fail("อีเมลหรือรหัสผ่านไม่ถูกต้อง", 401);
  }
  if (!canUse(user) || await isViewerAccount(env, user.id)) {
    return fail("บัญชีนี้ยังไม่มีสิทธิ์อัพโหลดภาพ (ต้องได้รับการกำหนดบทบาทในระบบ system ก่อน)", 403);
  }
  await env.DB.prepare("DELETE FROM activity_login_failures WHERE email = ? OR at < datetime('now','-1 day')").bind(email).run();
  const token = await signJWT({ sub: user.id, sv: user.session_version ?? 1, app: "activity" }, env.JWT_SECRET);
  return json({ user: { id: user.id, full_name: user.full_name, role: user.role, is_admin: ADMIN_ROLES.includes(user.role) } }, 200, { "Set-Cookie": buildSessionCookie(token) });
}

// ---------- อัลบั้ม ----------
async function listAlbums(url, env) {
  const q = String(url.searchParams.get("q") || "").trim().slice(0, 100);
  const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
  const where = q ? "a.deleted_at IS NULL AND a.title LIKE ?" : "a.deleted_at IS NULL";
  const binds = q ? [`%${q}%`] : [];
  const rows = await env.DB.prepare(`
    SELECT a.id, a.title, a.event_date, a.created_by, u.full_name AS created_by_name,
      (SELECT COUNT(*) FROM activity_photos p WHERE p.album_id = a.id AND p.deleted_at IS NULL) AS photo_count,
      COALESCE(
        (SELECT p.id FROM activity_photos p WHERE p.id = a.cover_photo_id AND p.album_id = a.id AND p.deleted_at IS NULL),
        (SELECT p.id FROM activity_photos p WHERE p.album_id = a.id AND p.deleted_at IS NULL ORDER BY p.id LIMIT 1)
      ) AS cover_id
    FROM activity_albums a LEFT JOIN users u ON u.id = a.created_by
    WHERE ${where} ORDER BY a.event_date ASC, a.id ASC LIMIT ? OFFSET ?`)
    .bind(...binds, PAGE_SIZE + 1, (page - 1) * PAGE_SIZE).all();
  const items = rows.results || [];
  return json({ albums: items.slice(0, PAGE_SIZE), has_more: items.length > PAGE_SIZE, page });
}

function getAlbum(env, id) {
  return env.DB.prepare("SELECT * FROM activity_albums WHERE id = ? AND deleted_at IS NULL").bind(id).first();
}

async function showAlbum(env, id) {
  const album = await env.DB.prepare(`SELECT a.id, a.title, a.event_date, a.cover_photo_id, a.created_by, a.created_at, u.full_name AS created_by_name
    FROM activity_albums a LEFT JOIN users u ON u.id = a.created_by WHERE a.id = ? AND a.deleted_at IS NULL`).bind(id).first();
  if (!album) return fail("ไม่พบงานนี้", 404);
  const photos = await env.DB.prepare(`SELECT id, file_name, width, height, uploaded_by, created_at FROM activity_photos
    WHERE album_id = ? AND deleted_at IS NULL ORDER BY id`).bind(id).all();
  return json({ album, photos: photos.results || [] });
}

function cleanTitle(value) {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  if (!title) return { error: "กรุณากรอกชื่องาน" };
  if (title.length > 150) return { error: "ชื่องานยาวเกิน 150 ตัวอักษร" };
  return { title };
}

async function createAlbum(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const { title, error } = cleanTitle(body.title);
  if (error) return fail(error);
  const configError = drive.driveConfigError(env);
  if (configError) return fail(configError, 503);
  const eventDate = drive.thaiToday(); // ประทับวันที่อัตโนมัติ (วันที่สร้างงาน ตามเวลาไทย)
  const name = drive.folderName(title, eventDate);
  const folderId = await drive.createFolder(env, name);
  // ซิงก์อาจเจอโฟลเดอร์ใหม่ก่อน → อัปเดตแถวเดิมให้เป็นของผู้สร้าง
  await env.DB.prepare(`INSERT INTO activity_albums (title, event_date, folder_name, drive_folder_id, created_by, source) VALUES (?, ?, ?, ?, ?, 'web')
    ON CONFLICT(drive_folder_id) DO UPDATE SET title = excluded.title, event_date = excluded.event_date, folder_name = excluded.folder_name, created_by = excluded.created_by, source = 'web'`)
    .bind(title, eventDate, name, folderId, user.id).run();
  const row = await env.DB.prepare("SELECT id FROM activity_albums WHERE drive_folder_id = ?").bind(folderId).first();
  return json({ album: { id: row.id, title, event_date: eventDate, folder_name: name } }, 201);
}

async function updateAlbum(request, env, user, id) {
  const album = await getAlbum(env, id);
  if (!album) return fail("ไม่พบงานนี้", 404);
  if (!canManageAlbum(user, album)) return fail("แก้ไขได้เฉพาะผู้สร้างงานหรือผู้ดูแลระบบ", 403);
  const body = await request.json().catch(() => ({}));
  if (body.title !== undefined) {
    const { title, error } = cleanTitle(body.title);
    if (error) return fail(error);
    if (title !== album.title) {
      const name = drive.folderName(title, album.event_date); // คงวันที่เดิมไว้
      await drive.renameFile(env, album.drive_folder_id, name);
      await env.DB.prepare("UPDATE activity_albums SET title = ?, folder_name = ?, updated_at = datetime('now') WHERE id = ?").bind(title, name, id).run();
    }
  }
  if (body.cover_photo_id !== undefined) {
    const photo = await env.DB.prepare("SELECT id FROM activity_photos WHERE id = ? AND album_id = ? AND deleted_at IS NULL").bind(Number(body.cover_photo_id), id).first();
    if (!photo) return fail("ไม่พบภาพที่เลือกเป็นภาพปก");
    await env.DB.prepare("UPDATE activity_albums SET cover_photo_id = ?, updated_at = datetime('now') WHERE id = ?").bind(photo.id, id).run();
  }
  return json({ ok: true });
}

async function deleteAlbum(env, user, id, ctx) {
  const album = await getAlbum(env, id);
  if (!album) return fail("ไม่พบงานนี้", 404);
  if (!canManageAlbum(user, album)) return fail("ลบได้เฉพาะผู้สร้างงานหรือผู้ดูแลระบบ", 403);
  await drive.trashFile(env, album.drive_folder_id); // โฟลเดอร์ทั้งชุดไปถังขยะ Drive (กู้คืนได้ 30 วัน)
  const photos = await env.DB.prepare("SELECT id FROM activity_photos WHERE album_id = ? AND deleted_at IS NULL").bind(id).all();
  await env.DB.batch([
    env.DB.prepare("UPDATE activity_albums SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?").bind(user.id, id),
    env.DB.prepare("UPDATE activity_photos SET deleted_at = datetime('now'), deleted_by = ? WHERE album_id = ? AND deleted_at IS NULL").bind(user.id, id),
  ]);
  ctx.waitUntil(Promise.all((photos.results || []).map((p) => purgeImageCache(p.id))));
  return json({ ok: true });
}

// ---------- ภาพ ----------
function safeFileName(name, mimeType) {
  const base = String(name || "").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim().slice(-120);
  if (base) return base;
  return `photo.${(mimeType.split("/")[1] || "jpg").replace("jpeg", "jpg")}`;
}

async function uploadPhoto(request, env, user, albumId) {
  const album = await getAlbum(env, albumId);
  if (!album) return fail("ไม่พบงานนี้", 404);
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_FILE_BYTES + 64 * 1024) return fail("ไฟล์ใหญ่เกิน 25 MB", 413);
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!file || typeof file === "string") return fail("ไม่พบไฟล์ภาพ");
  const mimeType = String(file.type || "").toLowerCase();
  if (!IMAGE_TYPES.includes(mimeType)) return fail("รองรับเฉพาะไฟล์ภาพ (JPG, PNG, WEBP, GIF, HEIC)");
  if (file.size > MAX_FILE_BYTES) return fail("ไฟล์ใหญ่เกิน 25 MB", 413);
  if (file.size === 0) return fail("ไฟล์ว่างเปล่า");
  const name = safeFileName(file.name, mimeType);
  const uploaded = await drive.uploadFile(env, album.drive_folder_id, name, mimeType, new Uint8Array(await file.arrayBuffer()));
  const meta = uploaded.imageMediaMetadata || {};
  await env.DB.prepare(`INSERT INTO activity_photos (album_id, drive_file_id, drive_parent_id, file_name, mime_type, file_size, width, height, uploaded_by, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'web') ON CONFLICT(drive_file_id) DO UPDATE SET uploaded_by = excluded.uploaded_by, source = 'web'`)
    .bind(albumId, uploaded.id, album.drive_folder_id, name, mimeType, file.size, meta.width || null, meta.height || null, user.id).run();
  const row = await env.DB.prepare("SELECT id FROM activity_photos WHERE drive_file_id = ?").bind(uploaded.id).first();
  await env.DB.prepare("UPDATE activity_albums SET updated_at = datetime('now') WHERE id = ?").bind(albumId).run();
  return json({ photo: { id: row.id, file_name: name } }, 201);
}

async function deletePhoto(env, user, photoId, ctx) {
  const photo = await env.DB.prepare("SELECT * FROM activity_photos WHERE id = ? AND deleted_at IS NULL").bind(photoId).first();
  if (!photo) return fail("ไม่พบภาพนี้", 404);
  const album = await getAlbum(env, photo.album_id);
  if (!album) return fail("ไม่พบงานนี้", 404);
  if (!canDeletePhoto(user, album, photo)) return fail("ลบได้เฉพาะผู้อัพโหลด ผู้สร้างงาน หรือผู้ดูแลระบบ", 403);
  await drive.trashFile(env, photo.drive_file_id);
  await env.DB.batch([
    env.DB.prepare("UPDATE activity_photos SET deleted_at = datetime('now'), deleted_by = ? WHERE id = ?").bind(user.id, photoId),
    env.DB.prepare("UPDATE activity_albums SET cover_photo_id = NULL, updated_at = datetime('now') WHERE id = ? AND cover_photo_id = ?").bind(album.id, photoId),
  ]);
  ctx.waitUntil(purgeImageCache(photoId));
  return json({ ok: true });
}

// ส่งภาพผ่าน Worker (ไฟล์ใน Drive ไม่ต้องเปิดสาธารณะ) + เก็บแคชที่ Cloudflare
const imageCacheKey = (origin, id, size) => new Request(`${origin}/img/${id}/${size}`);
let cacheOrigin = "https://activity.banpadengschool.ac.th";
async function purgeImageCache(id) {
  await Promise.all(["thumb", "full"].map((s) => caches.default.delete(imageCacheKey(cacheOrigin, id, s)).catch(() => {})));
}

async function serveImage(request, env, ctx, id, size) {
  const key = imageCacheKey(new URL(request.url).origin, id, size);
  const cached = await caches.default.match(key);
  if (cached) return cached;
  const photo = await env.DB.prepare(`SELECT p.drive_file_id, p.mime_type, p.file_name FROM activity_photos p
    JOIN activity_albums a ON a.id = p.album_id WHERE p.id = ? AND p.deleted_at IS NULL AND a.deleted_at IS NULL`).bind(id).first();
  if (!photo) return new Response("Not found", { status: 404 });
  let upstream = size === "thumb" ? await drive.fetchThumbnail(env, photo.drive_file_id, THUMB_SIZE).catch(() => null) : null;
  const isThumb = !!upstream;
  if (!upstream) upstream = await drive.fetchMedia(env, photo.drive_file_id);
  const headers = new Headers({
    "Content-Type": upstream.headers.get("Content-Type") || photo.mime_type,
    // ภาพย่อที่ได้จากภาพเต็ม (Drive ยังสร้างภาพย่อไม่เสร็จ) แคชสั้น ๆ เพื่อให้ครั้งหน้าได้ภาพย่อจริง
    "Cache-Control": size === "thumb" && !isThumb ? "public, max-age=600" : "public, max-age=86400",
    "X-Content-Type-Options": "nosniff",
  });
  if (size === "full" && new URL(request.url).searchParams.has("download")) {
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(photo.file_name)}`);
    return new Response(upstream.body, { headers });
  }
  const response = new Response(upstream.body, { headers });
  ctx.waitUntil(caches.default.put(key, response.clone()));
  return response;
}

// ---------- router ----------
function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

async function handle(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  cacheOrigin = url.origin;

  const img = path.match(/^\/img\/(\d+)\/(thumb|full)$/);
  if (img && method === "GET") { await ensureSchema(env); return serveImage(request, env, ctx, Number(img[1]), img[2]); }

  if (!path.startsWith("/api/")) {
    const res = await env.ASSETS.fetch(request);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
    return out;
  }

  if (method !== "GET" && !sameOrigin(request)) return fail("คำขอไม่ถูกต้อง", 403);
  await ensureSchema(env);

  if (path === "/api/login" && method === "POST") return login(request, env);
  if (path === "/api/logout" && method === "POST") return json({ ok: true }, 200, { "Set-Cookie": buildClearCookie() });

  const user = await currentUser(request, env);
  if (path === "/api/me" && method === "GET") return json({ user });
  if (path === "/api/albums" && method === "GET") return listAlbums(url, env);
  const albumMatch = path.match(/^\/api\/albums\/(\d+)$/);
  if (albumMatch && method === "GET") return showAlbum(env, Number(albumMatch[1]));

  // ด้านล่างต้องล็อกอิน
  if (!user) return fail("กรุณาเข้าสู่ระบบ", 401);
  if (path === "/api/albums" && method === "POST") return createAlbum(request, env, user);
  if (albumMatch && method === "PATCH") return updateAlbum(request, env, user, Number(albumMatch[1]));
  if (albumMatch && method === "DELETE") return deleteAlbum(env, user, Number(albumMatch[1]), ctx);
  const upload = path.match(/^\/api\/albums\/(\d+)\/photos$/);
  if (upload && method === "POST") return uploadPhoto(request, env, user, Number(upload[1]));
  const photoMatch = path.match(/^\/api\/photos\/(\d+)$/);
  if (photoMatch && method === "DELETE") return deletePhoto(env, user, Number(photoMatch[1]), ctx);

  return fail("ไม่พบหน้านี้", 404);
}

export default {
  // ซิงก์กับ Google Drive ทุก 10 นาที (wrangler.jsonc → triggers.crons)
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      console.log("sync", JSON.stringify(await runSync(env)));
    })());
  },
  async fetch(request, env, ctx) {
    try {
      return await handle(request, env, ctx);
    } catch (error) {
      console.error(error);
      return fail(String(error?.message || "เกิดข้อผิดพลาด").slice(0, 300), 500);
    }
  },
};

export { handle as _handleForTests };
