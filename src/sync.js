// ซิงก์โฟลเดอร์/ภาพใน Google Drive (โฟลเดอร์ Photo) → ฐานข้อมูล ทำงานทุก 10 นาที (cron)
// - โฟลเดอร์ย่อยระดับแรกใต้ Photo = อัลบั้ม (วันที่ = วันท้ายชื่อถ้ามี ไม่งั้นใช้วันที่สร้างโฟลเดอร์)
// - ภาพในอัลบั้ม = ไฟล์ภาพในโฟลเดอร์นั้น และในโฟลเดอร์ย่อยข้างใน (1 ชั้น)
// - เปลี่ยนชื่อ/ลบใน Drive → เว็บเปลี่ยนตาม
import * as drive from "./drive.js";

const IMAGE_Q = "mimeType contains 'image/' and trashed = false";
const IMAGE_FIELDS = "id,name,mimeType,size,parents,imageMediaMetadata(width,height)";
const ALBUMS_PER_RUN = 30;

const thaiDateOf = (iso) => drive.thaiToday(new Date(iso));

async function getState(env, key) {
  const row = await env.DB.prepare("SELECT value FROM activity_sync_state WHERE key = ?").bind(key).first();
  return row?.value ?? null;
}
const setState = (env, key, value) =>
  env.DB.prepare("INSERT INTO activity_sync_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(key, value).run();

async function syncFolders(env) {
  const root = String(env.ACTIVITY_DRIVE_FOLDER_ID);
  const folders = await drive.listAll(env,
    `'${drive.escapeQuery(root)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    "id,name,createdTime");
  const rows = (await env.DB.prepare("SELECT id, drive_folder_id, folder_name, deleted_at FROM activity_albums").all()).results || [];
  const byFolder = new Map(rows.map((r) => [r.drive_folder_id, r]));
  const seen = new Set();
  const stmts = [];
  for (const f of folders) {
    seen.add(f.id);
    const parsed = drive.parseFolderName(f.name);
    const row = byFolder.get(f.id);
    if (!row) {
      stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO activity_albums (title, event_date, folder_name, drive_folder_id, source, created_at)
        VALUES (?, ?, ?, ?, 'drive', ?)`).bind(parsed.title, parsed.date || thaiDateOf(f.createdTime), f.name, f.id, f.createdTime));
    } else if (!row.deleted_at && row.folder_name !== f.name) {
      stmts.push(env.DB.prepare("UPDATE activity_albums SET title = ?, folder_name = ?, updated_at = datetime('now') WHERE id = ?").bind(parsed.title, f.name, row.id));
    }
  }
  // โฟลเดอร์ถูกลบ/ย้ายออกจาก Photo → ซ่อนอัลบั้ม (กันพลาด: ถ้ารายการว่างทั้งหมด ไม่ลบอะไร)
  if (folders.length) {
    for (const r of rows) {
      if (!r.deleted_at && !seen.has(r.drive_folder_id)) {
        stmts.push(env.DB.prepare("UPDATE activity_albums SET deleted_at = datetime('now') WHERE id = ?").bind(r.id));
        stmts.push(env.DB.prepare("UPDATE activity_photos SET deleted_at = datetime('now') WHERE album_id = ? AND deleted_at IS NULL").bind(r.id));
      }
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { folders: folders.length, changes: stmts.length };
}

// ภาพใหม่ที่เพิ่มตรงใน Drive ตั้งแต่ครั้งก่อน → ให้อัลบั้มนั้นถูกตรวจในรอบนี้ก่อน
async function markRecentlyChanged(env) {
  const since = await getState(env, "images_checked_at");
  const now = new Date().toISOString();
  if (since) {
    const files = await drive.listAll(env, `${IMAGE_Q} and createdTime > '${since}'`, "id,parents");
    const parents = [...new Set(files.flatMap((f) => f.parents || []))];
    for (let i = 0; i < parents.length; i += 50) {
      const chunk = parents.slice(i, i + 50);
      const marks = chunk.map(() => "?").join(",");
      // โฟลเดอร์อัลบั้มเอง หรือโฟลเดอร์ย่อยข้างใน (ตรวจอัลบั้มทั้งหมดที่เคยมีโฟลเดอร์ย่อยนั้น)
      await env.DB.prepare(`UPDATE activity_albums SET synced_at = NULL WHERE deleted_at IS NULL AND (drive_folder_id IN (${marks})
        OR id IN (SELECT album_id FROM activity_photos WHERE drive_parent_id IN (${marks})))`).bind(...chunk, ...chunk).run();
    }
  }
  await setState(env, "images_checked_at", new Date(Date.parse(now) - 60000).toISOString());
}

export async function syncAlbumPhotos(env, album) {
  const fid = drive.escapeQuery(album.drive_folder_id);
  const subfolders = await drive.listAll(env, `'${fid}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, "id");
  let files = await drive.listAll(env, `'${fid}' in parents and ${IMAGE_Q}`, IMAGE_FIELDS);
  for (const sf of subfolders) {
    files = files.concat(await drive.listAll(env, `'${drive.escapeQuery(sf.id)}' in parents and ${IMAGE_Q}`, IMAGE_FIELDS));
  }
  files.sort((a, b) => String(a.name).localeCompare(String(b.name), "th", { numeric: true }));
  const existing = (await env.DB.prepare("SELECT id, drive_file_id, deleted_at FROM activity_photos WHERE album_id = ?").bind(album.id).all()).results || [];
  const known = new Map(existing.map((p) => [p.drive_file_id, p]));
  const present = new Set(files.map((f) => f.id));
  const stmts = [];
  for (const f of files) {
    if (known.has(f.id)) continue;
    const meta = f.imageMediaMetadata || {};
    stmts.push(env.DB.prepare(`INSERT OR IGNORE INTO activity_photos (album_id, drive_file_id, drive_parent_id, file_name, mime_type, file_size, width, height, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'drive')`).bind(album.id, f.id, (f.parents || [])[0] || null, f.name, f.mimeType, Number(f.size) || null, meta.width || null, meta.height || null));
  }
  for (const p of existing) {
    if (!p.deleted_at && !present.has(p.drive_file_id)) {
      stmts.push(env.DB.prepare("UPDATE activity_photos SET deleted_at = datetime('now') WHERE id = ?").bind(p.id));
    }
  }
  stmts.push(env.DB.prepare("UPDATE activity_albums SET synced_at = datetime('now') WHERE id = ?").bind(album.id));
  await env.DB.batch(stmts);
  return stmts.length - 1;
}

export async function runSync(env) {
  if (drive.driveConfigError(env)) return { skipped: true };
  const folderResult = await syncFolders(env);
  await markRecentlyChanged(env);
  // อัลบั้มที่ยังไม่เคยซิงก์/มีภาพใหม่ก่อน แล้วค่อยวนตรวจอัลบั้มที่ตรวจนานที่สุด
  const albums = (await env.DB.prepare(`SELECT id, drive_folder_id FROM activity_albums WHERE deleted_at IS NULL
    ORDER BY synced_at IS NOT NULL, synced_at LIMIT ?`).bind(ALBUMS_PER_RUN).all()).results || [];
  let photoChanges = 0;
  for (const album of albums) {
    try { photoChanges += await syncAlbumPhotos(env, album); }
    catch (e) { console.error("sync album", album.id, e?.message); }
  }
  return { ...folderResult, albums: albums.length, photo_changes: photoChanges };
}
