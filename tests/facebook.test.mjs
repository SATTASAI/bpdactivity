import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {FACEBOOK_DDL,FACEBOOK_JOBS_DDL,facebookConfig,recordFacebookPhoto,queueFacebook,flushFacebook,facebookRoute} from '../src/facebook.js';
function setup(count=3){
 const sql=new DatabaseSync(':memory:');sql.exec(`${FACEBOOK_DDL}${FACEBOOK_JOBS_DDL};
 CREATE TABLE activity_albums(id INTEGER PRIMARY KEY,title TEXT,description TEXT,audience TEXT,created_by INTEGER,deleted_at TEXT);
 CREATE TABLE activity_photos(id INTEGER PRIMARY KEY,album_id INTEGER,drive_file_id TEXT,uploaded_by INTEGER,deleted_at TEXT);
 CREATE TABLE users(id INTEGER,role TEXT,status TEXT,deleted_at TEXT);
 INSERT INTO activity_albums VALUES(1,'กิจกรรมทดสอบ','รายละเอียด','public',1,NULL);
 INSERT INTO users VALUES(1,'teacher','active',NULL);`);
 for(let i=1;i<=count;i++)sql.prepare('INSERT INTO activity_photos VALUES(?,1,?,1,NULL)').run(i,'file'+i);
 const prepare=(q,a=[])=>({bind:(...v)=>prepare(q,v),first:async()=>sql.prepare(q).get(...a),all:async()=>({results:sql.prepare(q).all(...a)}),run:async()=>({meta:{changes:sql.prepare(q).run(...a).changes}})});
 const env={ACTIVITY_DRIVE_FOLDER_ID:'root',DB:{prepare,batch:async ss=>Promise.all(ss.map(s=>s.run()))},FACEBOOK_PAGE_ID:'123',FACEBOOK_PAGE_ACCESS_TOKEN:'secret-test-token',GOOGLE_DRIVE_CLIENT_ID:'client',GOOGLE_DRIVE_CLIENT_SECRET:'secret',GOOGLE_DRIVE_REFRESH_TOKEN:'refresh'};
 const user={id:1,role:'teacher'},album=()=>sql.prepare('SELECT * FROM activity_albums WHERE id=1').get();
 const select=async ids=>{for(const id of ids)await recordFacebookPhoto(env,1,1,'batch',id).run();};
 return {sql,env,user,album,select,queue:expected=>queueFacebook(env,user,album(),'batch',{enabled:true,expected_count:expected}),jobs:()=>sql.prepare('SELECT * FROM activity_facebook_jobs ORDER BY id').all()};
}
function provider({feed,photo}={}){
 const original=globalThis.fetch,calls=[];let i=0;
 globalThis.fetch=async(url,init={})=>{
  url=String(url);calls.push({url,init});
  if(url.includes('oauth2'))return Response.json({access_token:'drive',expires_in:3600});
  if(url.includes('googleapis.com'))return new Response('IMAGE',{headers:{'Content-Type':'image/jpeg'}});
  assert.equal(init.headers.Authorization,'Bearer secret-test-token');
  if(url.endsWith('/photos')){assert.equal(init.body.get('published'),'false');assert(init.body.get('source') instanceof Blob);return photo?photo(++i):Response.json({id:String(100+i++)});}
  if(url.endsWith('/feed'))return feed?feed(init.body):Response.json({id:'123_999'});
  throw Error('unexpected request '+url);
 };
 return {calls,restore:()=>{globalThis.fetch=original;}};
}
test('per-upload opt-in and server-recorded selection publish only explicitly selected photos',async()=>{
 const s=setup();await s.select([1,3]);
 assert.equal((await queueFacebook(s.env,s.user,s.album(),'batch',{enabled:false})).status,'off');assert.equal(s.jobs().length,0);
 assert.equal((await s.queue(3)).status,'blocked');assert.equal(s.jobs().length,0);
 assert.equal((await s.queue(2)).status,'queued');assert.deepEqual(JSON.parse(s.jobs()[0].photo_ids),[1,3]);
 await s.queue(2);assert.equal(s.jobs().length,1);
 const p=provider({feed:body=>{const ids=[...body].filter(([k])=>k.startsWith('attached_media')).map(([,v])=>JSON.parse(v).media_fbid);assert.equal(ids.length,2);assert.match(body.get('message'),/กิจกรรมทดสอบ/);return Response.json({id:'123_999'});}});
 try{await Promise.all([flushFacebook(s.env),flushFacebook(s.env)]);await flushFacebook(s.env);assert.equal(p.calls.filter(c=>c.url.endsWith('/feed')).length,1);assert.equal(s.jobs()[0].status,'published');assert.equal(s.jobs()[0].post_id,'123_999');assert(p.calls.every(c=>!c.url.includes('secret-test-token')));}finally{p.restore();s.sql.close();}
});
test('selection cannot publish private albums, another uploader, missing/deleted images, or use an unconnected page',async()=>{
 const s=setup();await s.select([1]);
 s.sql.exec("UPDATE activity_albums SET audience='staff'");assert.equal((await s.queue(1)).status,'blocked');
 s.sql.exec("UPDATE activity_albums SET audience='public'");s.sql.exec('UPDATE activity_photos SET uploaded_by=2 WHERE id=1');assert.equal((await s.queue(1)).status,'blocked');
 s.sql.exec('UPDATE activity_photos SET uploaded_by=1 WHERE id=1');s.env.FACEBOOK_PAGE_ACCESS_TOKEN='';assert.equal((await s.queue(1)).status,'blocked');assert.equal(s.jobs().length,0);
 assert.equal(JSON.stringify(facebookConfig({...s.env,FACEBOOK_PAGE_ACCESS_TOKEN:'secret'})).includes('secret'),false);s.sql.close();
});
test('large selections are deterministically split into visible sets of ten without duplicate jobs',async()=>{
 const s=setup(21);await s.select(Array.from({length:21},(_,i)=>i+1));const result=await s.queue(21);
 assert.equal(result.post_count,3);assert.deepEqual(s.jobs().map(j=>JSON.parse(j.photo_ids).length),[10,10,1]);
 await s.queue(21);assert.equal(s.jobs().length,3);s.sql.close();
});
test('an uncertain final publish is never automatically sent again, including manual retry',async()=>{
 const s=setup(1);await s.select([1]);await s.queue(1);const p=provider({feed:()=>{throw new TypeError('network lost after submit');}});
 try{await flushFacebook(s.env);assert.equal(s.jobs()[0].status,'needs_review');await flushFacebook(s.env);assert.equal(p.calls.filter(c=>c.url.endsWith('/feed')).length,1);
 const res=await facebookRoute(new Request('https://activity.test/retry',{method:'POST',body:JSON.stringify({job_id:s.jobs()[0].id})}),s.env,s.user,s.album(),'retry');assert.equal(res.status,409);
 }finally{p.restore();s.sql.close();}
});
test('a stale final-publish lock requires review and does not issue another Facebook request',async()=>{
 const s=setup(1);await s.select([1]);await s.queue(1);s.sql.exec("UPDATE activity_facebook_jobs SET status='publishing',locked_until=0");const p=provider();
 try{await flushFacebook(s.env);assert.equal(s.jobs()[0].status,'needs_review');assert.equal(p.calls.length,0);}finally{p.restore();s.sql.close();}
});
test('privacy changes before final publish cancel publication; revoked accounts are also cancelled',async()=>{
 const s=setup(1);await s.select([1]);await s.queue(1);const p=provider({photo:()=>{s.sql.exec("UPDATE activity_albums SET audience='private'");return Response.json({id:'456'});}});
 try{await flushFacebook(s.env);assert.equal(s.jobs()[0].status,'cancelled');assert.equal(p.calls.filter(c=>c.url.endsWith('/feed')).length,0);}finally{p.restore();s.sql.close();}
 const t=setup(1);await t.select([1]);await t.queue(1);t.sql.exec("UPDATE users SET status='inactive'");const q=provider();try{await flushFacebook(t.env);assert.equal(t.jobs()[0].status,'cancelled');assert.equal(q.calls.length,0);}finally{q.restore();t.sql.close();}
});
test('a definitive Meta failure can be retried by the owner; stored media are cleared and secrets stay private',async()=>{
 const s=setup(1);await s.select([1]);await s.queue(1);let reject=true;
 const p=provider({feed:()=>reject?Response.json({error:{code:190,message:'sensitive provider response'}},{status:400}):Response.json({id:'123_1000'})});
 try{await flushFacebook(s.env);assert.equal(s.jobs()[0].status,'failed');assert(!s.jobs()[0].error.includes('sensitive'));
 const request=()=>new Request('https://activity.test/retry',{method:'POST',body:JSON.stringify({job_id:s.jobs()[0].id})});
 assert.equal((await facebookRoute(request(),s.env,{id:2,role:'teacher'},s.album(),'retry')).status,403);
 assert.equal((await facebookRoute(request(),s.env,s.user,s.album(),'retry')).status,200);assert.equal(s.jobs()[0].media_ids,'[]');reject=false;await flushFacebook(s.env);assert.equal(s.jobs()[0].status,'published');
 const list=await (await facebookRoute(new Request('https://activity.test'),s.env,s.user,s.album(),'list')).json();assert.equal(list.jobs[0].url,'https://www.facebook.com/123_1000');assert(!JSON.stringify(list).includes('secret-test-token'));
 }finally{p.restore();s.sql.close();}
});

