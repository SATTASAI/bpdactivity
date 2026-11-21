# AGENTS.md — ภาพกิจกรรมโรงเรียนบ้านป่าเด็ง (bpdactivity)

เว็บอัลบั้มภาพกิจกรรม ทุกคนดูได้ ครูล็อกอินบัญชี system เพื่อสร้างงาน/อัปโหลด ภาพเก็บใน Google Drive · https://activity.banpadengschool.ac.th

## ข้อมูลระบบ

- Cloudflare Worker `bpdactivity` (`run_worker_first: true`, `cpu_ms` 300000)
- D1 `DB` = `banpadeng_school_db` · Google Drive โฟลเดอร์ `ACTIVITY_DRIVE_FOLDER_ID`
- cron ทุกนาที (ซิงก์ Drive ทุก 10 นาที, คิวแจ้งเตือน, คิว Facebook)
- service binding `ACTIVITY_NOTIFY` → school-notify entrypoint `ActivityNotifications`
- เผยแพร่ไป Facebook Page แบบเลือกภาพ (`docs/facebook-publishing.md`)

## วิธีทำงานในรีโปนี้ (สำหรับ agent)

1. อ่านไฟล์นี้, `README.md` และเอกสารใน `docs/` (ถ้ามี) ก่อนแก้ทุกครั้ง
2. ทำเฉพาะขอบเขตที่ได้รับมอบหมาย ไม่ refactor, ไม่เปลี่ยนชื่อไฟล์/ตาราง/endpoint และไม่อัปเกรด dependency ถ้าไม่ได้สั่ง
3. ถ้างานกระทบข้อมูลจริง สิทธิ์ผู้ใช้ เงิน หรือระบบอื่น ให้หยุดถามก่อนลงมือ
4. แก้ให้น้อยที่สุดที่ทำให้งานสำเร็จ และเขียน/ปรับ test ที่ครอบคลุมพฤติกรรมที่เปลี่ยน
5. รันคำสั่งตรวจในหัวข้อ "คำสั่ง" ให้ผ่านทั้งหมดก่อน commit
6. ตอบผู้ใช้เป็นภาษาไทย กระชับ ข้อความ UI ทั้งหมดเป็นภาษาไทย

## คำสั่ง

```sh
npm ci --ignore-scripts
node --check src/index.js && node --check src/facebook.js && node --check public/app.js
npm test                 # node --test tests/*.test.mjs (Node 22+)
```

- CI: `.github/workflows/test.yml` รันชุดเดียวกัน

## โครงสร้างไฟล์

```
src/index.js     → router + scheduled()
src/drive.js     → Google Drive API · src/sync.js → ซิงก์โฟลเดอร์ ↔ อัลบั้ม
src/facebook.js  → เผยแพร่ Facebook · src/notify.js → แจ้งเตือนอัลบั้มใหม่
src/zip.js       → ดาวน์โหลดเป็น zip · src/crypto.js, src/lib/ → auth/passkey
public/          → app.js, index.html, style.css, facebook-picker.js
```

## ฐานข้อมูลกลาง `banpadeng_school_db` (ใช้ร่วมหลายระบบ)

ฐาน D1 นี้ใช้ร่วมกับ banpadeng-school-db (system), students-report, publicservice, bpdactivity,
teaching-media, evaluatesystem และ school-cooperative ความผิดพลาดที่นี่กระทบทุกระบบ

- เขียนได้เฉพาะตารางของรีโปนี้: `activity_*` (`activity_albums`, `activity_photos`, `activity_facebook_*`, `activity_notify_*`, `activity_sso_codes`, `activity_sync_state`, `activity_login_failures`)
- ตารางของระบบอื่นอ่านอย่างเดียว: `users`, `students`, `student_details`, `student_enrollments`, `academic_years`, `academic_terms`, `personnel_records` และตารางอื่นของ system
- ตาราง passkey กลาง (`auth_passkeys`, `auth_passkey_users`, `auth_passkey_challenges`, `auth_passkey_rates`) ใช้ร่วมทุกระบบ ห้ามเปลี่ยนโครงสร้าง
- schema สร้างอัตโนมัติด้วย `CREATE TABLE IF NOT EXISTS`/เพิ่มคอลัมน์แบบตรวจก่อน ห้าม `DROP`, `RENAME`, ลบคอลัมน์ หรือเปลี่ยนชนิดข้อมูล
- ห้ามรันคำสั่งเขียน/ลบบนฐานจริง (`--remote`) เพื่อทดสอบ; ใช้ฐาน local/shim หรือ fixture
- ระวังโควต้า D1: query ต้องใช้ index, จำกัดจำนวนแถว, ไม่ scan ทั้งตารางใน cron

## กติกาเฉพาะของระบบ (business rules)

- สร้างงาน = สร้างโฟลเดอร์ Drive ชื่อ `ชื่องาน (30 ต.ค. 2569)` ตามวันที่สร้างเวลาไทย
- แก้ชื่อ/ตั้งปก/ลบงาน: ผู้สร้าง หรือ superadmin/executive · ลบภาพ: ผู้อัปโหลดภาพนั้นได้ด้วย
- ลบ = ย้ายไปถังขยะ Drive (กู้คืนได้ 30 วัน) ห้ามลบถาวร
- อัลบั้มที่มาจาก Drive แก้/ลบผ่านเว็บได้เฉพาะผู้ดูแล
- ภาพส่งผ่าน Worker (`/img/:id/thumb|full`) ห้ามแชร์โฟลเดอร์ Drive เป็นสาธารณะ
- school-announcement ดึงข้อมูลอัลบั้มจากเว็บนี้ — อย่าเปลี่ยนรูปแบบ API สาธารณะโดยไม่ตรวจฝั่งนั้น

## ข้อตกลงการเขียนโค้ด

- เวลาและวันที่อิงเวลาไทย `Asia/Bangkok` (UTC+7) ทุกจุด ทั้งการคำนวณวัน ตัดรอบ และ cron; แสดงปีเป็น พ.ศ. แต่เก็บเป็น ISO/ค.ศ.
- SQL ใช้ prepared statement + `.bind()` เท่านั้น ห้ามต่อสตริงจากค่าที่ผู้ใช้ส่งมา
- ตรวจสิทธิ์ฝั่งเซิร์ฟเวอร์ทุก endpoint (role/status/session ปัจจุบันจากฐาน) อย่าเชื่อค่าจากหน้าเว็บ
- งานที่เขียนหลายแถวต้องเป็น atomic (`db.batch()`) และกันกดซ้ำ (idempotency key) เมื่อเป็นรายการเงินหรือรายการสำคัญ
- การลบข้อมูลสำคัญใช้ soft delete/ยกเลิกพร้อมเหตุผล และบันทึก audit แทนการลบแถว
- หน้าเว็บต้องใช้ได้บนมือถือ (iPhone Safari/PWA) และจอกว้าง ใช้ฟอนต์และสไตล์เดิมของรีโป
- escape ข้อความก่อนใส่ลง HTML เสมอ (กัน XSS) และอย่าเพิ่ม CDN/สคริปต์ภายนอกใหม่ถ้าไม่จำเป็น

## ความปลอดภัยและ secrets

- `JWT_SECRET` ของรีโปนี้แยกจาก system (สุ่มเอง)
- `GOOGLE_DRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN` ค่าเดียวกับ Worker `banpadeng-school-db`; `FACEBOOK_PAGE_ACCESS_TOKEN` เป็นความลับระดับสูง
- ห้าม commit secret, token, รหัสผ่าน, `.env`, `.dev.vars`, ไฟล์สำรองฐานข้อมูล หรือข้อมูลนักเรียน/บุคลากรจริงลง Git
- secret ตั้งผ่าน Cloudflare dashboard หรือ `wrangler secret put` เท่านั้น (`keep_vars: true` ทำให้ค่าที่ตั้งใน dashboard ไม่ถูกทับ)
- ข้อมูลนักเรียนเป็นข้อมูลส่วนบุคคลของผู้เยาว์: ห้าม log ชื่อ เลขประจำตัว ที่อยู่ หรือข้อมูลผู้ปกครองลง console/observability
- ห้ามปิดหรือผ่อนการตรวจสิทธิ์ การจำกัดความถี่ล็อกอิน Turnstile หรือ passkey เพื่อให้ทดสอบง่าย

## ห้ามแตะ / ต้องระวังเป็นพิเศษ

- `src/sync.js` (ซิงก์ผิดอาจลบ/ซ้ำอัลบั้มจำนวนมาก)
- งาน Facebook: ห้ามโพสต์จริงระหว่างทดสอบ ใช้ mock ใน `tests/facebook*.test.mjs`
- `ACTIVITY_DRIVE_FOLDER_ID` ใน `wrangler.jsonc` (แก้ที่ไฟล์นี้ที่เดียว)

## ระบบที่เชื่อมกัน

- banpadeng-school-db: บัญชีครู (SSO) · school-notify: แจ้งเตือนอัลบั้มใหม่ · school-announcement: ใช้อัลบั้มทำข่าว

## Deploy

- Git integration ของ Cloudflare กับ `main`: merge = ขึ้นจริง; โดเมนผูกจาก `routes`

## เลขเวอร์ชันกลาง (แพทช์ข้ามรีโป)

รีโปนี้เชื่อมกับระบบบริหารโรงเรียน (D1 กลาง, SSO บัญชี system, แจ้งเตือนผ่าน school-notify) จึงอยู่ในขอบเขตแพทช์กลาง:

- ทุกชุดการแก้ไขที่ merge/push เข้า `main` ต้องออกเลขแพทช์ใหม่ใน
  [`SATTASAI/banpadeng-school-db/CHANGELOG.md`](https://github.com/SATTASAI/banpadeng-school-db/blob/main/CHANGELOG.md) รวมงานเอกสาร
- อ่านเลขล่าสุดจาก CHANGELOG นั้นก่อนเสมอ ห้ามนับเลขแยกในรีโปนี้
- งานเล็ก/กลางเพิ่มเลขส่วนที่สาม งานใหญ่เพิ่มเลขส่วนที่สอง งานหลายรีโปในชุดเดียวใช้เลขเดียวและลิงก์ PR ทุกรีโป
- รายละเอียดกติกาอยู่ใน `README.md` ของ banpadeng-school-db หัวข้อ "เวอร์ชันและบันทึก Patch Update"

## Checklist ก่อนเปิด PR / merge

- [ ] test และ syntax check ทั้งหมดผ่าน
- [ ] ไม่มี secret/ข้อมูลจริงใน diff (`git diff --cached` ตรวจก่อน commit)
- [ ] ไม่แก้ `database_id`, `routes`, `services` และชื่อ Worker ใน wrangler config โดยไม่ได้สั่ง
- [ ] schema เปลี่ยนแบบเพิ่มเท่านั้น (add table/column) และรันซ้ำได้ ไม่ทำให้ข้อมูลเดิมหรือระบบอื่นพัง
- [ ] อัปเดต `README.md`/`docs/` เมื่อพฤติกรรมหรือขั้นตอนติดตั้งเปลี่ยน และบันทึกการตัดสินใจถาวรของผู้ใช้ลงไฟล์นี้
- [ ] commit/PR อธิบายเป็นภาษาไทยว่าเปลี่ยนอะไร เพราะอะไร และทดสอบอย่างไร
