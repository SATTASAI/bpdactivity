import * as drive from './drive.js';

export const PHOTOS_PER_POST=10;
export const FACEBOOK_DDL=`CREATE TABLE IF NOT EXISTS activity_facebook_uploads(
 album_id INTEGER NOT NULL,user_id INTEGER NOT NULL,batch_id TEXT NOT NULL,photo_id INTEGER NOT NULL,
 PRIMARY KEY(album_id,user_id,batch_id,photo_id));
`;
export const FACEBOOK_JOBS_DDL=`CREATE TABLE IF NOT EXISTS activity_facebook_jobs(
 id INTEGER PRIMARY KEY AUTOINCREMENT,album_id INTEGER NOT NULL,user_id INTEGER NOT NULL,batch_id TEXT NOT NULL,part INTEGER NOT NULL,
 page_id TEXT NOT NULL,photo_ids TEXT NOT NULL,media_ids TEXT NOT NULL DEFAULT '[]',message TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued',post_id TEXT,error TEXT,attempts INTEGER NOT NULL DEFAULT 0,
 next_at INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0,lock_token TEXT,
 created_at TEXT NOT NULL DEFAULT(datetime('now')),updated_at TEXT NOT NULL DEFAULT(datetime('now')),
 UNIQUE(album_id,user_id,batch_id,part))`;
const manage=(user,album)=>!!user&&(user.is_admin||['superadmin','executive'].includes(user.role)||Number(album.created_by)===Number(user.id));
const reply=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
export function facebookConfig(env){
 const configured=/^\d+$/.test(String(env.FACEBOOK_PAGE_ID||''))&&!!env.FACEBOOK_PAGE_ACCESS_TOKEN;
 return {configured,page_name:env.FACEBOOK_PAGE_NAME||'เพจโรงเรียน',photos_per_post:PHOTOS_PER_POST};
}
export function recordFacebookPhoto(env,album,user,batchId,photoId){
 return env.DB.prepare('INSERT OR IGNORE INTO activity_facebook_uploads(album_id,user_id,batch_id,photo_id) VALUES(?,?,?,?)').bind(album,user,batchId,photoId);
}
export async function queueFacebook(env,user,album,batchId,options){
 if(options?.enabled!==true)return {status:'off'};
 if(!manage(user,album)||album.audience!=='public')return {status:'blocked',error:'เผยแพร่ Facebook ได้เฉพาะเจ้าของหรือผู้ดูแลอัลบั้มสาธารณะ'};
 if(!facebookConfig(env).configured)return {status:'blocked',error:'ยังไม่ได้เชื่อมต่อเพจ Facebook'};
 const count=Number(options.expected_count);
 if(!Number.isInteger(count)||count<1||count>1000)return {status:'blocked',error:'กรุณาเลือกภาพที่จะเผยแพร่ 1–1,000 ภาพ'};
 const photos=(await env.DB.prepare(`SELECT p.id FROM activity_facebook_uploads u JOIN activity_photos p ON p.id=u.photo_id
  WHERE u.album_id=? AND u.user_id=? AND u.batch_id=? AND p.album_id=u.album_id AND p.uploaded_by=u.user_id AND p.deleted_at IS NULL ORDER BY p.id`)
  .bind(album.id,user.id,batchId).all()).results||[];
 if(photos.length!==count)return {status:'blocked',error:'ภาพที่เลือกส่งขึ้นเพจอัปโหลดไม่ครบ จึงยังไม่เผยแพร่ กรุณาตรวจสอบภาพที่อัปโหลดไม่สำเร็จ'};
 const caption=String(options.caption||'').trim();
 if(caption.length>4000)return {status:'blocked',error:'คำบรรยายยาวเกิน 4,000 ตัวอักษร'};
 const message=caption||[album.title,album.description].filter(Boolean).join('\n');
 const parts=Math.ceil(photos.length/PHOTOS_PER_POST),statements=[];
 for(let i=0;i<parts;i++)statements.push(env.DB.prepare(`INSERT OR IGNORE INTO activity_facebook_jobs(album_id,user_id,batch_id,part,page_id,photo_ids,message)
  VALUES(?,?,?,?,?,?,?)`).bind(album.id,user.id,batchId,i+1,String(env.FACEBOOK_PAGE_ID),JSON.stringify(photos.slice(i*PHOTOS_PER_POST,(i+1)*PHOTOS_PER_POST).map(p=>p.id)),
  `${message}${parts>1?'\nชุดที่ '+(i+1)+'/'+parts:''}\n\nดูภาพกิจกรรมทั้งหมด: https://activity.banpadengschool.ac.th/#/album/${album.id}`));
 await env.DB.batch(statements);
 return {status:'queued',photo_count:photos.length,post_count:parts};
}
export async function facebookRoute(request,env,user,album,action){
 if(!user)return reply({error:'กรุณาเข้าสู่ระบบ'},401);
 if(action==='status')return reply(facebookConfig(env));
 if(!album||!manage(user,album))return reply({error:'ไม่มีสิทธิ์จัดการการเผยแพร่อัลบั้มนี้'},403);
 if(action==='list'){
  const rows=(await env.DB.prepare(`SELECT id,part,status,photo_ids,post_id,error,created_at FROM activity_facebook_jobs WHERE album_id=? ORDER BY id DESC LIMIT 100`).bind(album.id).all()).results||[];
  return reply({jobs:rows.map(({photo_ids,...j})=>({...j,photo_count:JSON.parse(photo_ids).length,url:j.post_id?'https://www.facebook.com/'+j.post_id:null}))});
 }
 if(album.audience!=='public')return reply({error:'เปลี่ยนอัลบั้มเป็นสาธารณะก่อนเผยแพร่'},409);
 const body=await request.json().catch(()=>({}));
 const changed=await env.DB.prepare(`UPDATE activity_facebook_jobs SET status='queued',media_ids='[]',error=NULL,next_at=0,attempts=0 WHERE id=? AND album_id=? AND status='failed' AND locked_until<?`).bind(Number(body.job_id),album.id,Date.now()).run();
 return changed.meta?.changes?reply({ok:true}):reply({error:'รายการนี้ไม่สามารถส่งซ้ำได้ หากสถานะไม่แน่ชัดให้ตรวจสอบบนเพจก่อน'},409);
}
async function graph(env,path,body,publishing=false){
 const version=/^v\d+\.\d+$/.test(env.FACEBOOK_GRAPH_VERSION||'')?env.FACEBOOK_GRAPH_VERSION:'v25.0';
 try{
  const response=await fetch(`https://graph.facebook.com/${version}/${path}`,{method:'POST',headers:{Authorization:`Bearer ${env.FACEBOOK_PAGE_ACCESS_TOKEN}`},body,signal:AbortSignal.timeout(12000)});
  const data=await response.json().catch(()=>null);
  if(data?.error)throw Object.assign(new Error(`Facebook ปฏิเสธคำขอ (รหัส ${Number(data.error.code)||response.status}) ตรวจสอบการเชื่อมต่อและสิทธิ์เพจ`),{definite:true});
  if(!response.ok||!/^\d+(?:_\d+)?$/.test(String(data?.id||'')))throw new Error('ยังยืนยันผลจาก Facebook ไม่ได้');
  return String(data.id);
 }catch(error){if(publishing&&!error.definite)error.uncertain=true;throw error;}
}
async function facebookImage(env,photo){
 let response=await drive.fetchMedia(env,photo.drive_file_id),blob=await response.blob();
 const supported=['image/jpeg','image/png','image/gif','image/bmp','image/tiff'];
 if(!supported.includes(blob.type)||blob.size>10*1024*1024){
  response=await drive.fetchThumbnail(env,photo.drive_file_id,2048);
  if(!response)throw new Error('Google Drive ยังไม่พร้อมแปลงภาพสำหรับ Facebook กรุณาลองส่งอีกครั้ง');
  blob=await response.blob();
 }
 if(!supported.includes(blob.type)||!blob.size||blob.size>10*1024*1024)throw new Error('ภาพสำหรับ Facebook ต้องเป็น JPG/PNG/GIF/BMP/TIFF และไม่เกิน 10 MB');
 return blob;
}
export async function flushFacebook(env,{budgetMs=18000}={}){
 if(!facebookConfig(env).configured)return;
 const now=Date.now();
 await env.DB.prepare(`UPDATE activity_facebook_jobs SET status='published',locked_until=0 WHERE status='publishing' AND post_id IS NOT NULL`).run();
 // A crash after submitting the final post is ambiguous. Never repost automatically.
 await env.DB.prepare(`UPDATE activity_facebook_jobs SET status='needs_review',error='ยังยืนยันผลไม่ได้ กรุณาตรวจสอบโพสต์บนเพจก่อนส่งใหม่' WHERE status='publishing' AND locked_until<?`).bind(now).run();
 const job=await env.DB.prepare(`SELECT * FROM activity_facebook_jobs WHERE status IN ('queued','uploading') AND next_at<=? AND locked_until<? ORDER BY id LIMIT 1`).bind(now,now).first();
 if(!job)return;
 const token=crypto.randomUUID();
 const claimed=await env.DB.prepare(`UPDATE activity_facebook_jobs SET locked_until=?,lock_token=? WHERE id=? AND status IN ('queued','uploading') AND locked_until<?`).bind(now+180000,token,job.id,now).run();
 if(!claimed.meta?.changes)return;
 const save=async(status,error=null)=>env.DB.prepare(`UPDATE activity_facebook_jobs SET status=?,error=?,locked_until=0,lock_token=NULL,updated_at=datetime('now') WHERE id=? AND lock_token=?`).bind(status,error,job.id,token).run();
 try{
  const album=await env.DB.prepare('SELECT * FROM activity_albums WHERE id=? AND deleted_at IS NULL').bind(job.album_id).first();
  const user=await env.DB.prepare('SELECT id,role,status,deleted_at FROM users WHERE id=?').bind(job.user_id).first();
  if(!album||album.audience!=='public'||!user||user.status!=='active'||user.deleted_at||!['teacher','staff','executive','superadmin'].includes(user.role)||!manage(user,album))return await save('cancelled','ยกเลิกเพราะอัลบั้มหรือสิทธิ์เผยแพร่เปลี่ยนไป');
  if(String(env.FACEBOOK_PAGE_ID)!==job.page_id)return await save('failed','เพจที่เชื่อมต่อเปลี่ยนไป กรุณาตรวจสอบก่อนส่งใหม่');
  const ids=JSON.parse(job.photo_ids),media=JSON.parse(job.media_ids);
  const photos=(await env.DB.prepare('SELECT id,drive_file_id FROM activity_photos WHERE album_id=? AND deleted_at IS NULL').bind(job.album_id).all()).results||[];
  if(ids.some(id=>!photos.some(p=>p.id===id)))return await save('cancelled','ภาพที่เลือกถูกลบหรือย้ายไปแล้ว');
  while(media.length<ids.length){
   if(Date.now()-now>budgetMs)return await save('uploading');
   const photo=photos.find(p=>p.id===ids[media.length]);
   const blob=await facebookImage(env,photo),form=new FormData();form.set('source',blob,'activity.jpg');form.set('published','false');
   const id=await graph(env,`${job.page_id}/photos`,form);media.push(id);
   await env.DB.prepare(`UPDATE activity_facebook_jobs SET media_ids=?,status='uploading',updated_at=datetime('now') WHERE id=? AND lock_token=?`).bind(JSON.stringify(media),job.id,token).run();
  }
  if(Date.now()-now>budgetMs)return await save('uploading');
  // Revalidate visibility immediately before the irreversible publish request.
  const current=await env.DB.prepare('SELECT audience,deleted_at FROM activity_albums WHERE id=?').bind(job.album_id).first();
  if(!current||current.deleted_at||current.audience!=='public')return await save('cancelled','อัลบั้มไม่ได้เป็นสาธารณะแล้ว');
  const prepared=await env.DB.prepare(`UPDATE activity_facebook_jobs SET status='publishing' WHERE id=? AND lock_token=?`).bind(job.id,token).run();
  if(!prepared.meta?.changes)return;
  const form=new URLSearchParams({message:job.message});media.forEach((id,i)=>form.set(`attached_media[${i}]`,JSON.stringify({media_fbid:id})));
  const postId=await graph(env,`${job.page_id}/feed`,form,true);
  await env.DB.prepare(`UPDATE activity_facebook_jobs SET post_id=? WHERE id=? AND lock_token=?`).bind(postId,job.id,token).run();
  await save('published');
 }catch(error){
  const status=await env.DB.prepare('SELECT status FROM activity_facebook_jobs WHERE id=?').bind(job.id).first();
  if(error.uncertain||status?.status==='publishing'&&!error.definite)return await save('needs_review','ยังยืนยันผลจาก Facebook ไม่ได้ กรุณาตรวจสอบโพสต์บนเพจก่อนส่งใหม่');
  await save('failed',String(error.message||'ส่งภาพขึ้น Facebook ไม่สำเร็จ').slice(0,200));
 }
}
