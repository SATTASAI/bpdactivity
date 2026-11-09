import test from 'node:test';
import assert from 'node:assert/strict';
import {mountFacebookPicker} from '../public/facebook-picker.js';
class Element{
 constructor(){this.children=[];this.value='';this.dataset={};this.checked=false;}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(...nodes){this.children=nodes;}
 setAttribute(key,value){this[key]=value;}
 querySelectorAll(){return this.children.map(label=>label.children[0]);}
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function setup(config={configured:true,page_name:'โรงเรียน',photos_per_post:10}){
 const previous=globalThis.document;globalThis.document={createElement:()=>new Element()};
 const elements=new Map();const root={set innerHTML(_value){},querySelector(selector){if(!elements.has(selector))elements.set(selector,new Element());return elements.get(selector);}};
 const files=[new File(['a'],'หนึ่ง.jpg',{type:'image/jpeg'}),new File(['b'],'สอง.jpg',{type:'image/jpeg'})];
 let audience='public',allowed=true;
 const picker=mountFacebookPicker(root,{api:async()=>config,files,audience:()=>audience,canPublish:()=>allowed});
 return {picker,files,get:key=>root.querySelector(`[data-fb-${key}]`),setAudience:v=>audience=v,setAllowed:v=>allowed=v,close(){picker.dispose();globalThis.document=previous;}};
}
test('Facebook starts off, requires an explicit photo choice, and keeps the exact selected file identity',async()=>{
 const s=setup();try{await settle();assert.equal(s.picker.read().enabled,false);
 s.get('enable').checked=true;s.get('enable').onchange();assert.throws(()=>s.picker.read(),/ติ๊กเลือก/);
 const first=s.get('photos').children[0].children[0];first.checked=true;first.onchange();
 const options=s.picker.read();assert.equal(options.expected_count,1);assert(options.selected.has(s.files[0]));assert(!options.selected.has(s.files[1]));assert.match(s.get('count').textContent,/1 จาก 2/);
 s.get('all').onclick();assert.equal(s.picker.read().expected_count,2);s.get('none').onclick();assert.throws(()=>s.picker.read(),/ติ๊กเลือก/);
 }finally{s.close();}
});
test('private/unauthorized albums and missing configuration cannot enable publishing; changing files clears old selection',async()=>{
 const s=setup();try{await settle();s.get('enable').checked=true;s.get('all').onclick();s.picker.setFiles([s.files[1]]);assert.throws(()=>s.picker.read(),/ติ๊กเลือก/);
 s.setAudience('staff');s.picker.update();assert.equal(s.get('enable').disabled,true);assert.equal(s.picker.read().enabled,false);
 s.setAudience('public');s.setAllowed(false);s.picker.update();assert.equal(s.get('enable').disabled,true);
 }finally{s.close();}
 const t=setup({configured:false});try{await settle();assert.equal(t.get('enable').disabled,true);assert.match(t.get('hint').textContent,/ยังไม่ได้เชื่อมต่อ/);}finally{t.close();}
});
