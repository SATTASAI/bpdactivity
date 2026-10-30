// Google Drive: ใช้บัญชีเดียวกับระบบ system (OAuth refresh token) เก็บภาพกิจกรรมในโฟลเดอร์ ACTIVITY_DRIVE_FOLDER_ID

const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];

// วันที่ตามเวลาไทย รูปแบบ YYYY-MM-DD (ค.ศ.)
export function thaiToday(now = new Date()) {
  return new Date(now.getTime() + 7 * 3600000).toISOString().slice(0, 10);
}

// "2026-10-30" → "30 ต.ค. 2569"
export function thaiDateLabel(isoDate) {
  const [y, m, d] = String(isoDate).split("-").map(Number);
  return `${d} ${THAI_MONTHS[m - 1]} ${y + 543}`;
}

// ชื่อโฟลเดอร์: "ชื่องาน (30 ต.ค. 2569)" — ตัดอักขระที่ Drive/ระบบไฟล์ไม่ชอบ
export function folderName(title, isoDate) {
  const clean = String(title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return `${clean} (${thaiDateLabel(isoDate)})`;
}

export function driveConfigError(env) {
  const missing = ["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_CLIENT_SECRET", "GOOGLE_DRIVE_REFRESH_TOKEN", "ACTIVITY_DRIVE_FOLDER_ID"]
    .filter((k) => !env[k]);
  return missing.length ? `ยังไม่ได้ตั้งค่า Google Drive: ${missing.join(", ")}` : null;
}

// access token อายุ ~1 ชม. เก็บไว้ในหน่วยความจำของ isolate เพื่อลดการขอซ้ำ
let cachedToken = null;
export async function accessToken(env) {
  if (cachedToken && cachedToken.exp > Date.now() + 60000) return cachedToken.token;
  const err = driveConfigError(env);
  if (err) throw new Error(err);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: String(env.GOOGLE_DRIVE_CLIENT_ID),
      client_secret: String(env.GOOGLE_DRIVE_CLIENT_SECRET),
      refresh_token: String(env.GOOGLE_DRIVE_REFRESH_TOKEN),
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(`เชื่อมต่อ Google Drive ไม่สำเร็จ (${res.status})${data?.error === "invalid_grant" ? " · โทเคนหมดอายุ ต้องเชื่อมต่อใหม่" : ""}`);
  }
  cachedToken = { token: data.access_token, exp: Date.now() + Number(data.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function driveFetch(env, path, options = {}) {
  const token = await accessToken(env);
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  const url = path.startsWith("http") ? path
    : path.startsWith("/upload/") ? `https://www.googleapis.com${path}`
      : `https://www.googleapis.com/drive/v3${path}`;
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Google Drive ตอบกลับ ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return res;
}

export async function createFolder(env, name) {
  const res = await driveFetch(env, "/files?fields=id&supportsAllDrives=true", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [String(env.ACTIVITY_DRIVE_FOLDER_ID)] }),
  });
  return (await res.json()).id;
}

export async function renameFile(env, fileId, name) {
  await driveFetch(env, `/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

// ย้ายไปถังขยะ (กู้คืนใน Drive ได้ 30 วัน) แทนการลบถาวร
export async function trashFile(env, fileId) {
  if (!fileId) return;
  await driveFetch(env, `/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trashed: true }),
  });
}

export async function uploadFile(env, folderId, name, mimeType, bytes) {
  const boundary = `act_${crypto.randomUUID()}`;
  const metadata = JSON.stringify({ name, mimeType, parents: [folderId] });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    bytes,
    `\r\n--${boundary}--`,
  ]);
  const res = await driveFetch(env, "/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,size,imageMediaMetadata(width,height,rotation)", {
    method: "POST",
    headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

// ภาพเต็ม
export function fetchMedia(env, fileId) {
  return driveFetch(env, `/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
}

// ภาพย่อจาก Drive (ถ้ายังสร้างไม่เสร็จ คืน null ให้ผู้เรียกใช้ภาพเต็มแทน)
export async function fetchThumbnail(env, fileId, size) {
  const meta = await (await driveFetch(env, `/files/${encodeURIComponent(fileId)}?fields=thumbnailLink&supportsAllDrives=true`)).json();
  if (!meta.thumbnailLink) return null;
  const url = meta.thumbnailLink.replace(/=s\d+(-c)?$/, "") + `=s${size}`;
  const token = await accessToken(env);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res.ok ? res : null;
}

// ภาพย่อจากภาพเต็มผ่าน Cloudflare Image Resizing (หมุนตาม EXIF) — ถ้าย่อไม่ได้ คืน null
export async function fetchResized(env, fileId, size) {
  const token = await accessToken(env);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
    cf: { image: { width: size, height: size, fit: "scale-down", quality: 82 } },
  });
  return res.ok && !String(res.headers.get("cf-resized") || "").includes("err") ? res : null;
}

// รายการไฟล์ทั้งหมดตาม query (วนทุกหน้า)
export async function listAll(env, q, fields) {
  const out = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await (await driveFetch(env, `/files?${params}`)).json();
    out.push(...(data.files || []));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return out;
}

export function escapeQuery(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

// "ชื่องาน (30 ต.ค. 2569)" → { title: "ชื่องาน", date: "2026-10-30" } ; ชื่อที่ไม่มีวันที่ท้าย → date = null
export function parseFolderName(name) {
  const m = String(name).match(/^(.*\S)\s*\((\d{1,2}) (\S+) (\d{4})\)$/);
  const month = m ? THAI_MONTHS.indexOf(m[3]) : -1;
  if (!m || month < 0) return { title: String(name).trim(), date: null };
  const date = `${Number(m[4]) - 543}-${String(month + 1).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  return { title: m[1], date };
}

// ย้ายไฟล์ไปโฟลเดอร์อื่น
export async function moveFile(env, fileId, toFolderId, fromFolderId) {
  const params = new URLSearchParams({ addParents: toFolderId, supportsAllDrives: "true" });
  if (fromFolderId && fromFolderId !== toFolderId) params.set("removeParents", fromFolderId);
  await driveFetch(env, `/files/${encodeURIComponent(fileId)}?${params}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}
