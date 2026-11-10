import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { NOTIFY_DDL, queueAlbumCreated, queueUpload, flushNotifications } from '../src/notify.js';
function setup(audience='public') {
  const sql=new DatabaseSync(':memory:');
  sql.exec(`${NOTIFY_DDL}; CREATE TABLE activity_notify_deliveries(delivery_key TEXT PRIMARY KEY);
    CREATE TABLE activity_albums(id INTEGER PRIMARY KEY,title TEXT,audience TEXT,created_by INTEGER,deleted_at TEXT,drive_folder_id TEXT);
    CREATE TABLE users(id INTEGER,role TEXT,status TEXT,deleted_at TEXT); CREATE TABLE viewer_accounts(user_id INTEGER);
    INSERT INTO users VALUES(1,'teacher','active',NULL),(2,'teacher','active',NULL),(3,'executive','active',NULL),
      (4,'teacher','inactive',NULL),(5,'teacher','active',NULL),(6,'student','active',NULL);
    INSERT INTO viewer_accounts VALUES(5);`);
  sql.prepare("INSERT INTO activity_albums VALUES(1,?,?,1,NULL,'folder1')").run('กิจกรรม',audience);
  const prepare=(q,a=[])=>({bind:(...v)=>prepare(q,v),first:async()=>sql.prepare(q).get(...a),all:async()=>({results:sql.prepare(q).all(...a)}),run:async()=>({meta:{changes:sql.prepare(q).run(...a).changes}})});
  const DB={prepare,batch:async ss=>Promise.all(ss.map(s=>s.run()))};
  return {sql,env:{DB,NOTIFY_API_KEY:'test-key'}};
}
const ready=(sql)=>sql.exec('UPDATE activity_notify_batches SET ready_at=0,locked_until=0');
test('one batch for multiple photos; targeted refs exclude inactive/viewer/student; retry does not duplicate acknowledged delivery',async()=>{
  const {sql,env}=setup();const calls=[];const original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,id:1});};
  try {
    await queueUpload(env,1,1,'batch').run();await queueUpload(env,1,1,'batch').run();ready(sql);
    await Promise.all([flushNotifications(env),flushNotifications(env)]);
    assert.equal(calls.length,1);assert.deepEqual(calls[0].refs,['u:1','u:2','u:3']);
    assert.match(calls[0].body,/2 ภาพ/);assert.match(calls[0].url,/#\/album\/1$/);
    await flushNotifications(env);assert.equal(calls.length,1);
  } finally {globalThis.fetch=original;sql.close();}
});
test('new albums send to active teachers through the binding, with two links and no repeat',async()=>{
  const {sql,env}=setup('staff'),calls=[];
  delete env.NOTIFY_API_KEY;
  env.ACTIVITY_NOTIFY={send:async message=>{calls.push(message);return {ok:true,id:1};}};
  try {
    await queueAlbumCreated(env,'folder1',1).run();
    await queueAlbumCreated(env,'folder1',1).run();
    await queueUpload(env,1,1,'existing-upload').run();ready(sql);
    await Promise.all([flushNotifications(env),flushNotifications(env)]);
    assert.equal(calls.length,1);
    assert.deepEqual(calls[0].refs,['u:1','u:2']);
    assert.equal(calls[0].title,'อัลบั้มกิจกรรมใหม่');
    assert.deepEqual(calls[0].actions,[
      {title:'เปิดอัลบั้ม',url:'https://activity.banpadengschool.ac.th/#/album/1'},
      {title:'เว็บภาพกิจกรรม',url:'https://activity.banpadengschool.ac.th/'},
    ]);
    assert.equal(sql.prepare("SELECT sent_at FROM activity_notify_batches WHERE batch_id='existing-upload'").get().sent_at,null);
  } finally {sql.close();}
});
test('a new album changed to private is delivered only to its eligible teacher owner',async()=>{
  const {sql,env}=setup(),calls=[];
  env.ACTIVITY_NOTIFY={send:async message=>{calls.push(message);return {ok:true,id:1};}};
  try {
    await queueAlbumCreated(env,'folder1',1).run();ready(sql);
    sql.exec("UPDATE activity_albums SET audience='private'");
    await flushNotifications(env);
    assert.deepEqual(calls.map(message=>message.refs),[['u:1']]);
  } finally {sql.close();}
});
test('visibility checked at delivery, private album only owner and admin; no retroactive backlog before uploads',async()=>{
  const {sql,env}=setup();const calls=[];const original=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{calls.push(JSON.parse(init.body));return Response.json({ok:true,id:1});};
  try {
    await flushNotifications(env);assert.equal(calls.length,0);
    await queueUpload(env,1,2,'private').run();ready(sql);sql.exec("UPDATE activity_albums SET audience='private'");
    await flushNotifications(env);assert.deepEqual(calls[0].refs,['u:1','u:3']);
  } finally {globalThis.fetch=original;sql.close();}
});
test('missing key preserves queue; failures retry; deleted albums never send',async()=>{
  const {sql,env}=setup();const original=globalThis.fetch;let calls=0;
  try {
    await queueUpload(env,1,1,'retry').run();ready(sql);
    await flushNotifications({...env,NOTIFY_API_KEY:''});assert.equal(sql.prepare('SELECT sent_at FROM activity_notify_batches').get().sent_at,null);
    globalThis.fetch=async()=>{calls++;return new Response('',{status:503});};
    await flushNotifications(env);assert.equal(calls,1);assert.equal(sql.prepare('SELECT sent_at FROM activity_notify_batches').get().sent_at,null);
    ready(sql);globalThis.fetch=async()=>{calls++;return Response.json({ok:true,id:2});};await flushNotifications(env);assert.equal(calls,2);
    await queueUpload(env,1,1,'deleted').run();ready(sql);sql.exec("UPDATE activity_albums SET deleted_at='now'");await flushNotifications(env);assert.equal(calls,2);
  } finally {globalThis.fetch=original;sql.close();}
});
