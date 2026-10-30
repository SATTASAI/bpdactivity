# bpdactivity — ภาพกิจกรรมโรงเรียนบ้านป่าเด็ง

`activity.banpadengschool.ac.th` · Cloudflare Worker + D1 (ฐานเดียวกับ system) + Google Drive

- ทุกคนดูภาพได้ ไม่ต้องล็อกอิน
- ครูล็อกอินด้วยบัญชี system (ต้องมีบทบาทแล้ว) → สร้างงาน + อัพภาพ
- สร้างงาน = สร้างโฟลเดอร์ใน Drive ชื่อ `ชื่องาน (30 ต.ค. 2569)` (วันที่วันสร้างงาน ตามเวลาไทย)
- แก้ชื่องาน/ตั้งภาพปก/ลบงาน: ผู้สร้างงาน หรือ superadmin/executive · ลบภาพ: ผู้อัพภาพนั้นได้ด้วย
- ลบ = ย้ายไปถังขยะ Drive (กู้คืนได้ 30 วัน)
- ภาพส่งผ่าน Worker (`/img/:id/thumb|full`) ไม่ต้องแชร์โฟลเดอร์ Drive เป็นสาธารณะ

## ตั้งค่า (ครั้งแรก)
1. `wrangler.jsonc` → ใส่ `ACTIVITY_DRIVE_FOLDER_ID` (ID โฟลเดอร์หลักใน Drive)
2. Cloudflare → Worker `bpdactivity` → Settings → Variables and Secrets เพิ่ม Secret:
   - `JWT_SECRET` (สุ่มใหม่ ไม่ต้องเหมือน system)
   - `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, `GOOGLE_DRIVE_REFRESH_TOKEN` (ค่าเดียวกับ Worker `banpadeng-school-db`)
3. Deploy (Git integration) → โดเมน `activity.banpadengschool.ac.th` ผูกอัตโนมัติจาก `routes`

ตารางฐานข้อมูล (`activity_albums`, `activity_photos`, `activity_login_failures`) สร้างเองตอนใช้งานครั้งแรก

## ทดสอบ
`npm test` (Node 22+)
