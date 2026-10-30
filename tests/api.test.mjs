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
const driveCalls = [];
globalThis.fetch = async (url, init = {}) => {
  url = String(url); driveCalls.push({ url, method: init.method || "GET", body: init.body });
  if (url.includes("oauth2")) return Response.json({ access_token: "tok", expires_in: 3600 });
  if (url.includes("/upload/")) return Response.json({ id: `file${driveCalls.length}`, imageMediaMetadata: { width: 10, height: 8 } });
  if (url.includes("fields=thumbnailLink")) return Response.json({ thumbnailLink: "https://lh3.example/t=s220" });
  if (url.startsWith("https://lh3.example/")) return new Response("THUMB", { headers: { "Content-Type": "image/jpeg" } });
  if (url.includes("alt=media")) return new Response("FULL", { headers: { "Content-Type": "image/jpeg" } });
  if (url.endsWith("/files?fields=id&supportsAllDrives=true")) return Response.json({ id: "folder1" });
  return Response.json({});
};

const { _handleForTests: handle } = await import("../src/index.js");
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
