// ทดสอบ API แบบไม่ต่อเน็ต: D1 จำลองด้วย node:sqlite, Google Drive จำลองด้วย fetch ปลอม
// รัน: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { generateSalt, hashPassword } from "../src/crypto.js";
import { folderName, thaiDateLabel } from "../src/drive.js";

function d1(db) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } }; },
  });
  return { prepare: (sql) => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); } };
}

const store = new Map();
globalThis.caches = { default: { match: async (k) => store.get(k.url)?.clone(), put: async (k, r) => { store.set(k.url, r); }, delete: async (k) => store.delete(k.url) } };
const driveCalls = []; let uploadSeq = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url); driveCalls.push({ url, method: init.method || "GET", body: init.body });
  if (url.includes("oauth2")) return Response.json({ access_token: "tok", expires_in: 3600 });
  if (url.includes("/upload/")) return Response.json({ id: `file${++uploadSeq}`, imageMediaMetadata: { width: 10, height: 8 } });
  if (url.includes("fields=thumbnailLink")) return Response.json({ thumbnailLink: "https://lh3.example/t=s220" });
  if (url.startsWith("https://lh3.example/")) return new Response("THUMB", { headers: { "Content-Type": "image/jpeg" } });
  if (url.includes("alt=media")) return new Response("FULL", { headers: { "Content-Type": "image/jpeg" } });
  if (url.endsWith("/files?fields=id&supportsAllDrives=true")) return Response.json({ id: `folder${++uploadSeq}` });
  if (url.includes("/files?") && url.includes("q=")) return Response.json({ files: driveList(new URL(url).searchParams.get("q")) });
  return Response.json({});
};

// Drive จำลองสำหรับซิงก์: root → โฟลเดอร์ → ภาพ
let fakeDrive = { folders: [], files: [] };
function driveList(q) {
  const parent = (q.match(/^'([^']+)' in parents/) || [])[1];
  if (q.includes("google-apps.folder")) return fakeDrive.folders.filter((f) => f.parent === parent);
  if (q.includes("createdTime >")) return fakeDrive.files;
  return fakeDrive.files.filter((f) => f.parents[0] === parent);
}
const { _handleForTests: handle, ensureSchema } = await import("../src/index.js");
const { runSync } = await import("../src/sync.js");
const sql = new DatabaseSync(":memory:");
sql.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, password_hash TEXT, password_salt TEXT, full_name TEXT, role TEXT, status TEXT, session_version INTEGER DEFAULT 1, deleted_at TEXT);
  CREATE TABLE viewer_accounts (user_id INTEGER PRIMARY KEY);`);
const salt = generateSalt();
const hash = await hashPassword("pass1234", salt);
const add = sql.prepare("INSERT INTO users (id,email,password_hash,password_salt,full_name,role,status) VALUES (?,?,?,?,?,?, 'active')");
add.run(1, "t1@x.th", hash, salt, "ครูหนึ่ง", "teacher");
add.run(2, "t2@x.th", hash, salt, "ครูสอง", "teacher");
add.run(3, "new@x.th", hash, salt, "ยังไม่มีบทบาท", null);
add.run(4, "admin@x.th", hash, salt, "ผู้ดูแล", "superadmin");
const env = { DB: d1(sql), JWT_SECRET: "s", GOOGLE_DRIVE_CLIENT_ID: "a", GOOGLE_DRIVE_CLIENT_SECRET: "b", GOOGLE_DRIVE_REFRESH_TOKEN: "c", ACTIVITY_DRIVE_FOLDER_ID: "root", ASSETS: { fetch: async () => new Response("asset") } };
const ctx = { waitUntil: () => {} };
const O = "https://activity.test";
const call = async (path, { method = "GET", body, cookie, headers = {} } = {}) => {
  const h = new Headers(headers);
  if (cookie) h.set("Cookie", cookie);
  if (body && !(body instanceof FormData)) { h.set("Content-Type", "application/json"); body = JSON.stringify(body); }
  const res = await handle(new Request(O + path, { method, body, headers: h }), env, ctx);
  return { res, data: res.headers.get("Content-Type")?.includes("json") ? await res.json() : await res.text() };
};
const loginAs = async (email) => { const { res } = await call("/api/login", { method: "POST", body: { email, password: "pass1234" } }); assert.equal(res.status, 200); return res.headers.get("Set-Cookie").split(";")[0]; };

test("วันที่และชื่อโฟลเดอร์", () => {
  assert.equal(thaiDateLabel("2026-10-30"), "30 ต.ค. 2569");
  assert.equal(folderName(" กีฬาสี / ภายใน ", "2026-01-05"), "กีฬาสี ภายใน (5 ม.ค. 2569)");
});

test("ขั้นตอนครบ: ล็อกอิน สร้างงาน อัพภาพ ดูสาธารณะ แก้ไข ลบ", async () => {
  assert.equal((await call("/api/login", { method: "POST", body: { email: "t1@x.th", password: "wrong" } })).res.status, 401);
  assert.equal((await call("/api/login", { method: "POST", body: { email: "new@x.th", password: "pass1234" } })).res.status, 403);
  assert.equal((await call("/api/albums", { method: "POST", body: { title: "x" } })).res.status, 401);

  const c1 = await loginAs("t1@x.th");
  assert.equal((await call("/api/me", { cookie: c1 })).data.user.full_name, "ครูหนึ่ง");
  // ข้ามโดเมน → ปฏิเสธ
  assert.equal((await call("/api/albums", { method: "POST", body: { title: "x" }, cookie: c1, headers: { Origin: "https://evil.test" } })).res.status, 403);

  const { res, data } = await call("/api/albums", { method: "POST", body: { title: "กีฬาสีภายใน" }, cookie: c1 });
  assert.equal(res.status, 201);
  assert.match(data.album.folder_name, /^กีฬาสีภายใน \(\d+ .+ 25\d\d\)$/);
  const id = data.album.id;

  const fd = new FormData(); fd.append("file", new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg" }));
  assert.equal((await call(`/api/albums/${id}/photos`, { method: "POST", body: fd, cookie: c1 })).res.status, 201);
  const bad = new FormData(); bad.append("file", new File(["x"], "a.pdf", { type: "application/pdf" }));
  assert.equal((await call(`/api/albums/${id}/photos`, { method: "POST", body: bad, cookie: c1 })).res.status, 400);

  // สาธารณะเห็นงานและภาพ
  const list = (await call("/api/albums")).data.albums;
  assert.equal(list[0].photo_count, 1);
  const photoId = list[0].cover_id;
  assert.equal((await call(`/img/${photoId}/thumb`)).data, "THUMB");
  assert.equal((await call(`/img/${photoId}/full`)).data, "FULL");

  // ครูอีกคนแก้ไข/ลบงานไม่ได้ แต่ผู้ดูแลทำได้
  const c2 = await loginAs("t2@x.th");
  assert.equal((await call(`/api/albums/${id}`, { method: "PATCH", body: { title: "y" }, cookie: c2 })).res.status, 403);
  assert.equal((await call(`/api/photos/${photoId}`, { method: "DELETE", cookie: c2 })).res.status, 403);
  assert.equal((await call(`/api/albums/${id}`, { method: "PATCH", body: { title: "กีฬาสี 2569" }, cookie: c1 })).res.status, 200);
  assert.ok(driveCalls.some((c) => c.method === "PATCH" && String(c.body).includes("กีฬาสี 2569 (")));

  const cA = await loginAs("admin@x.th");
  assert.equal((await call(`/api/photos/${photoId}`, { method: "DELETE", cookie: cA })).res.status, 200);
  assert.equal((await call(`/img/${photoId}/full`)).res.status, 404);
  assert.equal((await call(`/api/albums/${id}`, { method: "DELETE", cookie: c1 })).res.status, 200);
  assert.equal((await call("/api/albums")).data.albums.length, 0);

  // เปลี่ยนรหัสผ่านใน system (session_version เพิ่ม) → หลุดจากระบบนี้ด้วย
  sql.exec("UPDATE users SET session_version = 2 WHERE id = 1");
  assert.equal((await call("/api/me", { cookie: c1 })).data.user, null);
});

test("ซิงก์จาก Drive: ดึงอัลบั้ม+ภาพ เรียงเก่า→ใหม่ เปลี่ยนชื่อ/ลบตาม Drive", async () => {
  fakeDrive = {
    folders: [
      { id: "fA", name: "ทอดผ้าป่าโรงเรียน 2569", createdTime: "2026-09-07T11:20:59Z", parent: "root" },
      { id: "fB", name: "วันพ่อแห่งชาติ 2567", createdTime: "2024-12-04T03:00:00Z", parent: "root" },
      { id: "fC", name: "งานใหม่ (5 ม.ค. 2569)", createdTime: "2026-10-30T03:00:00Z", parent: "root" },
      { id: "fA1", name: "ช่วงเช้า", parent: "fA" },
    ],
    files: [
      { id: "i1", name: "a.jpg", mimeType: "image/jpeg", parents: ["fA"] },
      { id: "i2", name: "b.jpg", mimeType: "image/jpeg", parents: ["fA1"] },
      { id: "i3", name: "c.jpg", mimeType: "image/jpeg", parents: ["fB"] },
    ],
  };
  const r = await runSync(env);
  assert.equal(r.folders, 3);
  const albums = (await call("/api/albums")).data.albums;
  assert.deepEqual(albums.map((a) => a.title), ["ทอดผ้าป่าโรงเรียน 2569", "งานใหม่", "วันพ่อแห่งชาติ 2567"]);
  assert.deepEqual(albums.map((a) => a.event_date), ["2026-09-07", "2026-01-05", "2024-12-04"]);
  const pa = albums.find((a) => a.title.startsWith("ทอดผ้าป่า"));
  assert.equal(pa.photo_count, 2); // รวมภาพในโฟลเดอร์ย่อย

  // ครูอัพภาพเข้าอัลบั้มที่ซิงก์มา → ไฟล์ไปโฟลเดอร์เดิมใน Drive
  const c1 = await loginAs("t2@x.th");
  const fd = new FormData(); fd.append("file", new File([new Uint8Array([1])], "x.jpg", { type: "image/jpeg" }));
  driveCalls.length = 0;
  assert.equal((await call(`/api/albums/${pa.id}/photos`, { method: "POST", body: fd, cookie: c1 })).res.status, 201);
  const up = sql.prepare("SELECT drive_file_id, drive_parent_id FROM activity_photos WHERE source = 'web' AND album_id = ?").get(pa.id);
  assert.equal(up.drive_parent_id, "fA");
  fakeDrive.files.push({ id: up.drive_file_id, name: "x.jpg", mimeType: "image/jpeg", parents: ["fA"] });
  // ครูทั่วไปลบอัลบั้มจาก Drive ไม่ได้ (ไม่มีผู้สร้าง)
  assert.equal((await call(`/api/albums/${pa.id}`, { method: "DELETE", cookie: c1 })).res.status, 403);

  // ใน Drive: เปลี่ยนชื่อ fB, ลบภาพ i1, ลบโฟลเดอร์ fC
  fakeDrive.folders[1].name = "วันพ่อ 2567";
  fakeDrive.folders.splice(2, 1);
  fakeDrive.files = fakeDrive.files.filter((f) => f.id !== "i1");
  sql.exec("UPDATE activity_albums SET synced_at = NULL");
  await runSync(env);
  const after = (await call("/api/albums")).data.albums;
  assert.deepEqual(after.map((a) => a.title), ["ทอดผ้าป่าโรงเรียน 2569", "วันพ่อ 2567"]);
  assert.equal(after[0].photo_count, 2); // b.jpg + x.jpg ที่อัพผ่านเว็บ
});

test("ย้ายตารางรุ่นแรก (created_by NOT NULL) ได้โดยข้อมูลไม่หาย", async () => {
  const db2 = new DatabaseSync(":memory:");
  db2.exec(`CREATE TABLE activity_albums (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, event_date TEXT NOT NULL, folder_name TEXT NOT NULL,
    drive_folder_id TEXT NOT NULL, cover_photo_id INTEGER, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT, deleted_by INTEGER);
    CREATE TABLE activity_photos (id INTEGER PRIMARY KEY AUTOINCREMENT, album_id INTEGER NOT NULL REFERENCES activity_albums(id), drive_file_id TEXT NOT NULL,
    file_name TEXT NOT NULL, mime_type TEXT NOT NULL, file_size INTEGER, width INTEGER, height INTEGER, uploaded_by INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), deleted_at TEXT, deleted_by INTEGER);
    INSERT INTO activity_albums (title, event_date, folder_name, drive_folder_id, created_by) VALUES ('ก', '2026-10-30', 'ก (30 ต.ค. 2569)', 'fX', 1);
    INSERT INTO activity_photos (album_id, drive_file_id, file_name, mime_type, uploaded_by) VALUES (1, 'pX', 'a.jpg', 'image/jpeg', 1);`);
  const mod = await import("../src/index.js?fresh");
  await mod.ensureSchema({ DB: d1(db2) });
  const cols = db2.prepare("PRAGMA table_info(activity_albums)").all();
  assert.equal(cols.find((c) => c.name === "created_by").notnull, 0);
  assert.equal(db2.prepare("SELECT drive_parent_id FROM activity_photos").get().drive_parent_id, "fX");
  assert.equal(db2.prepare("SELECT created_by FROM activity_albums").get().created_by, 1);
});

test("ล็อกอินได้แม้ไม่ได้ตั้ง JWT_SECRET, แก้วันที่/คำอธิบาย, ลบ/ย้ายหลายภาพ, ดาวน์โหลด zip", async () => {
  const saved = env.JWT_SECRET; delete env.JWT_SECRET;
  const c = await loginAs("admin@x.th");
  assert.equal((await call("/api/me", { cookie: c })).data.user.full_name, "ผู้ดูแล");

  const mk = async (title) => (await call("/api/albums", { method: "POST", body: { title }, cookie: c })).data.album.id;
  const a = await mk("งาน A"), b = await mk("งาน B");

  const ids = [];
  for (const n of ["x.jpg", "x.jpg", "y.jpg"]) {
    const fd = new FormData(); fd.append("file", new File([new Uint8Array([1, 2, 3, 4])], n, { type: "image/jpeg" }));
    await call(`/api/albums/${a}/photos`, { method: "POST", body: fd, cookie: c });
  }
  for (const r of sql.prepare("SELECT id FROM activity_photos WHERE album_id = ? AND deleted_at IS NULL ORDER BY id").all(a)) ids.push(r.id);
  assert.equal(ids.length, 3);

  // แก้วันที่ + คำอธิบาย → ชื่อโฟลเดอร์ Drive เปลี่ยนตาม
  driveCalls.length = 0;
  assert.equal((await call(`/api/albums/${a}`, { method: "PATCH", body: { title: "งาน A", event_date: "2026-02-14", description: "กิจกรรมวันแห่งความรัก" }, cookie: c })).res.status, 200);
  assert.ok(driveCalls.some((x) => String(x.body).includes("งาน A (14 ก.พ. 2569)")));
  const shown = (await call(`/api/albums/${a}`)).data.album;
  assert.equal(shown.event_date, "2026-02-14"); assert.equal(shown.description, "กิจกรรมวันแห่งความรัก");
  assert.equal((await call(`/api/albums/${a}`, { method: "PATCH", body: { event_date: "2026-13-40" }, cookie: c })).res.status, 400);

  // ดาวน์โหลด zip (ทุกคน)
  const info = (await call(`/api/albums/${a}/download`)).data;
  assert.equal(info.parts.length, 1); assert.equal(info.parts[0].count, 3);
  const zres = await handle(new Request(O + info.parts[0].url), env, ctx);
  const zbuf = new Uint8Array(await zres.arrayBuffer());
  const { writeFileSync } = await import("node:fs"); const { execFileSync } = await import("node:child_process");
  writeFileSync("/tmp/act-test.zip", zbuf);
  const listing = execFileSync("unzip", ["-l", "/tmp/act-test.zip"]).toString();
  assert.match(listing, /x \(2\)\.jpg/); assert.match(listing, /y\.jpg/);
  execFileSync("unzip", ["-t", "/tmp/act-test.zip"]); // CRC ถูกต้อง

  // ครูอื่นลบ/ย้ายภาพของคนอื่นไม่ได้
  const c2 = await loginAs("t2@x.th");
  assert.equal((await call("/api/photos/delete", { method: "POST", body: { ids }, cookie: c2 })).res.status, 403);
  // ย้าย 2 ภาพไปงาน B
  driveCalls.length = 0;
  const mv = (await call("/api/photos/move", { method: "POST", body: { ids: ids.slice(0, 2), album_id: b }, cookie: c })).data;
  assert.equal(mv.moved, 2);
  assert.ok(driveCalls.some((x) => x.method === "PATCH" && x.url.includes("addParents=folder")));
  assert.equal((await call(`/api/albums/${b}`)).data.photos.length, 2);
  // ลบหลายภาพ
  const del = (await call("/api/photos/delete", { method: "POST", body: { ids: ids.slice(0, 2) }, cookie: c })).data;
  assert.equal(del.deleted, 2);
  assert.equal((await call(`/api/albums/${b}`)).data.photos.length, 0);
  assert.equal((await call("/api/album-options", { cookie: c })).data.albums.length >= 2, true);
  env.JWT_SECRET = saved;
});

test("ภาพปกอัตโนมัติเลือกภาพที่สัดส่วนพอดีกรอบ (หมุนภาพแนวตั้งถูก)", async () => {
  fakeDrive = {
    folders: [{ id: "fCov", name: "ทดสอบปก", createdTime: "2026-10-01T03:00:00Z", parent: "root" }],
    files: [
      { id: "v1", name: "1.jpg", mimeType: "image/jpeg", parents: ["fCov"], imageMediaMetadata: { width: 3000, height: 4000 } },
      { id: "v2", name: "2.jpg", mimeType: "image/jpeg", parents: ["fCov"], imageMediaMetadata: { width: 4000, height: 3000, rotation: 1 } },
      { id: "v3", name: "3.jpg", mimeType: "image/jpeg", parents: ["fCov"], imageMediaMetadata: { width: 1920, height: 1080 } },
      { id: "v4", name: "4.jpg", mimeType: "image/jpeg", parents: ["fCov"], imageMediaMetadata: { width: 4000, height: 3000 } },
    ],
  };
  sql.exec("UPDATE activity_albums SET deleted_at = datetime('now')");
  await runSync(env);
  const al = (await call("/api/albums")).data.albums.find((x) => x.title === "ทดสอบปก");
  const want = sql.prepare("SELECT id FROM activity_photos WHERE drive_file_id = 'v3'").get().id;
  assert.equal(al.cover_id, want);
  assert.equal((await call(`/api/albums/${al.id}`)).data.album.cover_id, want);
  const v2 = sql.prepare("SELECT width, height FROM activity_photos WHERE drive_file_id = 'v2'").get();
  assert.deepEqual([v2.width, v2.height], [3000, 4000]);
});
