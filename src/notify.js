// Durable notification queue for album creation and completed photo uploads.
const ALBUM_CREATED = 'album:created';
const ACTIVITY_HOME = 'https://activity.banpadengschool.ac.th/';
export const NOTIFY_DDL = `CREATE TABLE IF NOT EXISTS activity_notify_batches (
  album_id INTEGER NOT NULL, user_id INTEGER NOT NULL, batch_id TEXT NOT NULL,
  photo_count INTEGER NOT NULL DEFAULT 0, ready_at INTEGER NOT NULL, sent_at INTEGER,
  locked_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(album_id, user_id, batch_id))`;
export function queueUpload(env, albumId, userId, batchId) {
  return env.DB.prepare(`INSERT INTO activity_notify_batches(album_id,user_id,batch_id,photo_count,ready_at)
    VALUES (?,?,?,1,?) ON CONFLICT(album_id,user_id,batch_id) DO UPDATE SET
    photo_count=photo_count+1, ready_at=excluded.ready_at`).bind(albumId,userId,batchId,Date.now()+600000);
}
export function queueAlbumCreated(env, folderId, userId) {
  return env.DB.prepare(`INSERT OR IGNORE INTO activity_notify_batches(album_id,user_id,batch_id,ready_at)
    SELECT id,?,?,? FROM activity_albums WHERE drive_folder_id=?`).bind(userId,ALBUM_CREATED,Date.now(),folderId);
}
export async function flushNotifications(env) {
  if (!env.ACTIVITY_NOTIFY && !env.NOTIFY_API_KEY) return;
  const t = Date.now();
  const rows = (await env.DB.prepare(`SELECT * FROM activity_notify_batches WHERE sent_at IS NULL
    AND ready_at<=? AND locked_until<? AND (?=1 OR batch_id=?) ORDER BY ready_at LIMIT 10`)
    .bind(t,t,env.NOTIFY_API_KEY?1:0,ALBUM_CREATED).all()).results || [];
  for (const row of rows) {
    const created = row.batch_id === ALBUM_CREATED;
    const key = [row.album_id,row.user_id,row.batch_id];
    const lock = await env.DB.prepare(`UPDATE activity_notify_batches SET locked_until=?,attempts=attempts+1
      WHERE album_id=? AND user_id=? AND batch_id=? AND sent_at IS NULL AND locked_until<?`)
      .bind(t+300000,...key,t).run();
    if (!lock.meta?.changes) continue;
    try {
      // Check visibility again at delivery time (an album can have become private).
      const album = await env.DB.prepare('SELECT title,audience,created_by,deleted_at FROM activity_albums WHERE id=?').bind(row.album_id).first();
      if (album && !album.deleted_at) {
        const users = (await env.DB.prepare(`SELECT u.id,u.role FROM users u WHERE u.status='active' AND u.deleted_at IS NULL
          AND u.role IN ('teacher','staff','superadmin','executive')
          AND (?=0 OR u.role='teacher')
          AND NOT EXISTS(SELECT 1 FROM viewer_accounts v WHERE v.user_id=u.id)
          AND (? != 'private' OR u.id=? OR u.role IN ('superadmin','executive')) ORDER BY u.id`)
          .bind(created?1:0,album.audience || 'public',album.created_by).all()).results || [];
        const url = `${ACTIVITY_HOME}#/album/${row.album_id}`;
        // School Notify accepts at most 80 refs per request. Use individual recipient
        // chunks with a durable checkpoint so successful chunks aren't sent again.
        const pending=[];
        for (const user of users) {
          const deliveryKey=`${row.album_id}:${row.user_id}:${row.batch_id}:${user.id}`;
          if (!await env.DB.prepare('SELECT 1 FROM activity_notify_deliveries WHERE delivery_key=?').bind(deliveryKey).first())
            pending.push({ref:`u:${user.id}`,key:deliveryKey});
        }
        for (let i=0; i<pending.length; i+=80) {
          const chunk=pending.slice(i,i+80);
          const message = {
            title:created?'อัลบั้มกิจกรรมใหม่':'ภาพกิจกรรมอัปโหลดแล้ว',
            body:created?album.title:`${album.title}\nเพิ่มภาพ ${row.photo_count} ภาพ\n${url}`,
            url,roles:['all'],refs:chunk.map(u=>u.ref),source:created?'bpdactivity-album':'bpdactivity',
            actions:[{title:'เปิดอัลบั้ม',url}],
          };
          if (created) message.actions.push({title:'เว็บภาพกิจกรรม',url:ACTIVITY_HOME});
          let result;
          if (created && env.ACTIVITY_NOTIFY) result=await env.ACTIVITY_NOTIFY.send(message);
          else {
            const res=await fetch('https://notify.banpadengschool.ac.th/api/send', {
              method:'POST', headers:{authorization:`Bearer ${env.NOTIFY_API_KEY}`,'content-type':'application/json'},
              signal:AbortSignal.timeout(15000),body:JSON.stringify(message),
            });
            if (!res.ok) throw new Error(`School Notify HTTP ${res.status}`);
            result=await res.json();
          }
          if (!result.ok || !result.id) throw new Error('School Notify did not acknowledge delivery');
          await env.DB.batch(chunk.map(u=>env.DB.prepare('INSERT OR IGNORE INTO activity_notify_deliveries(delivery_key) VALUES (?)').bind(u.key)));
        }
      }
      await env.DB.prepare('UPDATE activity_notify_batches SET sent_at=? WHERE album_id=? AND user_id=? AND batch_id=?').bind(Date.now(),...key).run();
    } catch (error) {
      console.error('activity_notify delivery failed',String(error.message));
      await env.DB.prepare('UPDATE activity_notify_batches SET locked_until=? WHERE album_id=? AND user_id=? AND batch_id=?')
        .bind(Date.now()+Math.min(3600000,60000*2**Math.min(row.attempts,6)),...key).run();
    }
  }
}
