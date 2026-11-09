// Explicit opt-in for each upload. File objects keep selection stable after filtering.
export function mountFacebookPicker(root,{api,files=[],canPublish=()=>true,audience=()=>"public"}){
 let images=[],selected=new Set(),urls=[],config=null,disposed=false;
 root.innerHTML=`<section class="facebook-picker"><label class="facebook-switch"><input type="checkbox" data-fb-enable disabled><span><b>เผยแพร่ไปยัง Facebook ด้วย</b><small>เลือกเฉพาะภาพที่ต้องการส่งขึ้นเพจ</small></span></label>
 <p class="hint" data-fb-hint>กำลังตรวจสอบการเชื่อมต่อเพจ...</p><div data-fb-details hidden>
 <label class="field">คำบรรยายโพสต์<textarea data-fb-caption rows="3" maxlength="4000" placeholder="เว้นว่างเพื่อใช้ชื่อและคำอธิบายกิจกรรม"></textarea></label>
 <div class="facebook-selection"><strong data-fb-count aria-live="polite"></strong><div><button type="button" class="btn ghost sm" data-fb-all>เลือกทั้งหมด</button><button type="button" class="btn ghost sm" data-fb-none>ล้างที่เลือก</button></div></div>
 <div class="facebook-photo-grid" data-fb-photos></div></div></section>`;
 const q=s=>root.querySelector(s),enable=q('[data-fb-enable]'),details=q('[data-fb-details]');
 function update(){
  const allowed=canPublish()&&audience()==='public';
  enable.disabled=!config?.configured||!allowed;
  if(enable.disabled)enable.checked=false;
  details.hidden=!enable.checked;
  q('[data-fb-hint]').textContent=!allowed?'เผยแพร่ได้เฉพาะเจ้าของหรือผู้ดูแลอัลบั้มสาธารณะ':!config?'กำลังตรวจสอบการเชื่อมต่อเพจ...':!config.configured?'ยังไม่ได้เชื่อมต่อเพจ Facebook ผู้ดูแลต้องตั้งค่าการเชื่อมต่อก่อน':`เพจ: ${config.page_name} · ภาพอื่นยังเก็บใน bpdactivity ตามปกติ`;
  const count=selected.size,parts=Math.ceil(count/(config?.photos_per_post||10));
  q('[data-fb-count]').textContent=`เลือกขึ้นเพจ ${count} จาก ${images.length} ภาพ${parts>1?` · แบ่งเป็น ${parts} โพสต์ โพสต์ละไม่เกิน ${config?.photos_per_post||10} ภาพ`:''}`;
 }
 function dispose(){disposed=true;urls.forEach(url=>URL.revokeObjectURL(url));urls=[];}
 function setFiles(files){
  urls.forEach(url=>URL.revokeObjectURL(url));urls=[];images=files.filter(f=>f?.size&&(f.type.startsWith('image/')||/\.(heic|heif)$/i.test(f.name)));selected.clear();
  const grid=q('[data-fb-photos]');grid.replaceChildren();
  images.forEach((file,i)=>{
   const label=document.createElement('label'),checkbox=document.createElement('input'),image=document.createElement('img'),name=document.createElement('span');
   label.className='facebook-photo';checkbox.type='checkbox';checkbox.setAttribute('aria-label',`ส่งภาพ ${i+1}: ${file.name} ขึ้น Facebook`);
   checkbox.onchange=()=>{if(checkbox.checked)selected.add(file);else selected.delete(file);update();};
   const url=URL.createObjectURL(file);urls.push(url);image.src=url;image.alt='';image.loading='lazy';name.textContent=file.name;
   label.append(checkbox,image,name);grid.append(label);
  });update();
 }
 enable.onchange=update;
 q('[data-fb-all]').onclick=()=>{selected=new Set(images);q('[data-fb-photos]').querySelectorAll('input').forEach(el=>el.checked=true);update();};
 q('[data-fb-none]').onclick=()=>{selected.clear();q('[data-fb-photos]').querySelectorAll('input').forEach(el=>el.checked=false);update();};
 setFiles(files);
 api('/api/facebook/status').then(value=>{if(!disposed){config=value;update();}}).catch(()=>{if(!disposed){config={configured:false};update();}});
 return {setFiles,update,dispose,read(){
  if(!enable.checked)return {enabled:false,selected:new Set()};
  if(!canPublish()||audience()!=='public'||!config?.configured)throw Error('ยังไม่พร้อมเผยแพร่ Facebook');
  if(!selected.size)throw Error('กรุณาติ๊กเลือกภาพที่จะส่งขึ้นเพจ Facebook');
  if(selected.size>1000)throw Error('เลือกส่งขึ้น Facebook ได้สูงสุด 1,000 ภาพต่อชุด');
  return {enabled:true,selected:new Set(selected),expected_count:selected.size,caption:q('[data-fb-caption]').value.trim()};
 }};
}
