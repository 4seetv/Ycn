/**
 * Enlil HLS Worker V3.0
 * One-file Cloudflare Worker
 * - Browser UI with Diagnose / Info / Play
 * - Master passthrough or pinned quality
 * - Recursive HLS proxy
 * - Diagnostic table rendered in-page
 * Use only with streams you own or are authorized to proxy.
 */
const VERSION="3.0.0";
const UA="Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152 Mobile Safari/537.36";

export default {
 async fetch(request) {
  try {
   const u=new URL(request.url);
   if(request.method==="OPTIONS") return cors(new Response(null,{status:204}));
   if(u.pathname==="/") return html(UI(u.origin));
   if(u.pathname==="/health") return json({ok:true,version:VERSION});
   if(u.pathname==="/info") return info(request);
   if(u.pathname==="/diagnose") return diagnose(request);
   if(u.pathname==="/play") return play(request);
   if(u.pathname==="/resource") return resource(request);
   return json({ok:false,error:"not_found",version:VERSION},404);
  } catch(e) { return json({ok:false,error:String(e?.message||e),version:VERSION},500); }
 }
};

function safeUrl(s){
 let u; try{u=new URL(s)}catch{throw Error("Invalid URL")}
 if(!["http:","https:"].includes(u.protocol)) throw Error("Only HTTP/HTTPS allowed");
 const h=u.hostname.toLowerCase();
 if(h==="localhost"||h==="127.0.0.1"||h==="::1"||h.endsWith(".local")||
 /^10\./.test(h)||/^192\.168\./.test(h)||/^169\.254\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h))
   throw Error("Private/local destination blocked");
 return u;
}
function requestHeaders(req,ref="",origin=""){
 const h=new Headers({"User-Agent":UA,"Accept":"*/*","Accept-Encoding":"identity"});
 if(ref)h.set("Referer",ref);
 if(origin)h.set("Origin",origin);
 const range=req.headers.get("Range"); if(range)h.set("Range",range);
 return h;
}
async function upstream(req,url,ref="",origin=""){
 safeUrl(url);
 return fetch(url,{method:"GET",headers:requestHeaders(req,ref,origin),redirect:"follow"});
}
function parseAttrs(line){
 const out={}; const p=line.indexOf(":"); const s=p<0?"":line.slice(p+1);
 for(const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]]=m[2].replace(/^"|"$/g,"");
 return out;
}
function isMaster(t){return /#EXT-X-STREAM-INF:/i.test(t)}
function variants(t,base){
 const lines=t.split(/\r?\n/),out=[];
 for(let i=0;i<lines.length;i++){
  if(!lines[i].trim().startsWith("#EXT-X-STREAM-INF"))continue;
  let j=i+1; while(j<lines.length&&(!lines[j].trim()||lines[j].trim().startsWith("#")))j++;
  if(j>=lines.length)continue;
  const a=parseAttrs(lines[i]),res=(a.RESOLUTION||"").replace("×","x"),parts=res.split("x");
  const height=parts.length>1?Number(parts.at(-1)):null;
  out.push({id:out.length+1,height:Number.isFinite(height)?height:null,resolution:res||null,
   bandwidth:Number(a.BANDWIDTH)||null,url:new URL(lines[j].trim(),base).href});
 }
 return out;
}
async function getManifest(req,url,ref="",origin=""){
 const r=await upstream(req,url,ref,origin), text=await r.text();
 if(!r.ok) throw Error(`HTTP ${r.status}`);
 if(!text.trimStart().startsWith("#EXTM3U")) throw Error("Response is not HLS");
 return {r,text,url:r.url};
}
function publicHeaders(r){
 const keys=["content-type","content-length","server","via","cf-ray","cf-cache-status","cache-control","www-authenticate","location"];
 const o={}; for(const k of keys){const v=r.headers.get(k);if(v)o[k]=v} return o;
}
async function diagnose(req){
 const u=new URL(req.url),src=u.searchParams.get("url");
 if(!src)return json({ok:false,error:"Missing ?url="},400);
 try{
  const t0=Date.now(),mr=await upstream(req,src),text=await mr.clone().text();
  const result={ok:true,version:VERSION,master:{status:mr.status,final_url:mr.url,
   latency_ms:Date.now()-t0,content_type:mr.headers.get("content-type"),
   is_hls:text.trimStart().startsWith("#EXTM3U"),is_master:isMaster(text),headers:publicHeaders(mr)},variants:[]};
  if(!mr.ok||!result.master.is_hls)return json(result);
  for(const v of variants(text,mr.url)){
   const tests=[];
   for(const shape of [
    {name:"default",ref:"",origin:""},
    {name:"master-referer",ref:mr.url,origin:""},
    {name:"referer+origin",ref:mr.url,origin:new URL(mr.url).origin}
   ]){
    const ts=Date.now();
    try{
     const r=await upstream(req,v.url,shape.ref,shape.origin);
     let preview=""; if(!r.ok)try{preview=(await r.clone().text()).slice(0,240).replace(/\s+/g," ")}catch{}
     tests.push({name:shape.name,status:r.status,final_url:r.url,latency_ms:Date.now()-ts,
      content_type:r.headers.get("content-type"),headers:publicHeaders(r),body_preview:preview});
    }catch(e){tests.push({name:shape.name,error:String(e?.message||e),latency_ms:Date.now()-ts})}
   }
   result.variants.push({...v,tests});
  }
  return json(result);
 }catch(e){return json({ok:false,error:String(e?.message||e),version:VERSION},502)}
}
async function info(req){
 const u=new URL(req.url),src=u.searchParams.get("url"); if(!src)return json({ok:false,error:"Missing ?url="},400);
 try{
  const m=await getManifest(req,src), vv=isMaster(m.text)?variants(m.text,m.url):[];
  return json({ok:true,version:VERSION,type:isMaster(m.text)?"master":"media",
   final_url:m.url,qualities:vv.map(v=>({id:v.id,q:v.height||v.id,resolution:v.resolution,bandwidth:v.bandwidth}))});
 }catch(e){return json({ok:false,error:String(e?.message||e),version:VERSION},502)}
}
function proxied(origin,url,ref=""){
 const x=new URL(origin+"/resource");x.searchParams.set("u",url);if(ref)x.searchParams.set("r",ref);return x.href;
}
function rewrite(t,base,origin){
 return t.split(/\r?\n/).map(line=>{
  const s=line.trim(); if(!s)return line;
  if(s.startsWith("#")&&/URI="[^"]+"/i.test(line))
   return line.replace(/URI="([^"]+)"/g,(_,x)=>`URI="${proxied(origin,new URL(x,base).href,base)}"`);
  if(s.startsWith("#"))return line;
  return proxied(origin,new URL(s,base).href,base);
 }).join("\n");
}
function qualityChoices(v,q){
 if(!q||q==="auto")return [...v].sort((a,b)=>(a.bandwidth??9e15)-(b.bandwidth??9e15));
 const n=Number(q.replace(/\D/g,"")); const exact=v.find(x=>x.height===n);
 return exact?[exact]:[...v].sort((a,b)=>Math.abs((a.height??99999)-n)-Math.abs((b.height??99999)-n)).slice(0,1);
}
async function play(req){
 const u=new URL(req.url),src=u.searchParams.get("url"),q=(u.searchParams.get("q")||"auto").toLowerCase();
 if(!src)return json({ok:false,error:"Missing ?url="},400);
 try{
  const m=await getManifest(req,src);
  if(!isMaster(m.text))return m3u8(rewrite(m.text,m.url,u.origin),{"X-Enlil-Mode":"media"});
  const vv=variants(m.text,m.url); if(!vv.length)throw Error("Master has no variants");
  if(q==="master")return m3u8(rewrite(m.text,m.url,u.origin),{"X-Enlil-Mode":"master"});
  let last="No playable variant";
  for(const v of qualityChoices(vv,q)){
   try{
    const vm=await getManifest(req,v.url,m.url,new URL(m.url).origin);
    return m3u8(rewrite(vm.text,vm.url,u.origin),{"X-Enlil-Mode":"pinned","X-Enlil-Quality":String(v.height||v.id)});
   }catch(e){last=String(e?.message||e)}
  }
  throw Error(last);
 }catch(e){return json({ok:false,error:String(e?.message||e),version:VERSION},502)}
}
async function resource(req){
 const u=new URL(req.url),target=u.searchParams.get("u"),ref=u.searchParams.get("r")||"";
 if(!target)return json({ok:false,error:"Missing resource URL"},400);
 try{
  const org=ref?new URL(ref).origin:"",r=await upstream(req,target,ref,org);
  const ct=(r.headers.get("content-type")||"").toLowerCase();
  if(ct.includes("mpegurl")||new URL(r.url).pathname.toLowerCase().endsWith(".m3u8")){
   const t=await r.text(); if(!r.ok)throw Error(`HTTP ${r.status}`);
   return m3u8(rewrite(t,r.url,u.origin));
  }
  const h=new Headers({"Access-Control-Allow-Origin":"*","Cache-Control":"no-store",
   "Content-Type":r.headers.get("content-type")||"application/octet-stream"});
  for(const k of ["content-range","accept-ranges","etag","last-modified"]){const v=r.headers.get(k);if(v)h.set(k,v)}
  return new Response(r.body,{status:r.status,headers:h});
 }catch(e){return json({ok:false,error:String(e?.message||e),version:VERSION},502)}
}
function m3u8(t,extra={}){return new Response(t,{headers:{"Content-Type":"application/vnd.apple.mpegurl;charset=UTF-8","Access-Control-Allow-Origin":"*","Cache-Control":"no-store",...extra}})}
function cors(r){const h=new Headers(r.headers);h.set("Access-Control-Allow-Origin","*");h.set("Access-Control-Allow-Headers","Range, Content-Type");h.set("Access-Control-Allow-Methods","GET,HEAD,OPTIONS");return new Response(r.body,{status:r.status,headers:h})}
function json(x,s=200){return cors(new Response(JSON.stringify(x,null,2),{status:s,headers:{"content-type":"application/json;charset=UTF-8","cache-control":"no-store"}}))}
function html(x){return new Response(x,{headers:{"content-type":"text/html;charset=UTF-8","cache-control":"no-store"}})}
function UI(origin){return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Enlil Worker V3</title><style>
*{box-sizing:border-box}body{margin:0;background:#07101d;color:#edf4ff;font-family:system-ui}main{max-width:850px;margin:5vh auto;padding:16px}.card{background:#101b2b;border:1px solid #2c4262;border-radius:22px;padding:20px;box-shadow:0 20px 60px #0005}h1{margin:0 0 5px}.tag{color:#72e2b5}.mut{color:#91a5c0;font-size:13px}input,select,button{width:100%;padding:14px;margin:7px 0;border:1px solid #314969;border-radius:13px;background:#091424;color:#fff;font-size:15px}button{cursor:pointer;font-weight:700}.primary{background:#17345b}.diag{background:#15382f}.out{direction:ltr;text-align:left;white-space:pre-wrap;word-break:break-all;background:#050a11;border-radius:13px;padding:13px;margin-top:12px;min-height:48px;overflow:auto}.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}@media(max-width:600px){.grid{grid-template-columns:1fr}}table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}td,th{border-bottom:1px solid #263a55;padding:8px;text-align:right}.ok{color:#66e1a9}.bad{color:#ff7c88}
</style></head><body><main><div class=card><h1>Enlil HLS Worker <span class=tag>V3.0</span></h1><div class=mut>Master / Auto / جودة ثابتة + تشخيص مباشر داخل الصفحة</div>
<input id=src dir=ltr value="https://tmaxapp.site/8wirwjs76erftg/bein1ar.m3u8" placeholder="https://...m3u8">
<select id=q><option value=auto>Auto — أول جودة تعمل</option><option value=master>Master — جميع الجودات</option><option value=480>480p</option><option value=720>720p</option><option value=1080>1080p</option></select>
<div class=grid><button class=primary onclick=make()>إنشاء رابط M3U8</button><button class=diag onclick=diag()>تشخيص السيرفر والجودات</button></div>
<div id=out class=out>جاهز — الإصدار 3.0.0</div><div id=tbl></div>
</div></main><script>
const O='${origin}',out=document.getElementById('out'),tbl=document.getElementById('tbl');
function src(){return document.getElementById('src').value.trim()}
function make(){if(!src())return;const x=O+'/play?url='+encodeURIComponent(src())+'&q='+document.getElementById('q').value;out.textContent=x;tbl.innerHTML=''}
async function diag(){if(!src())return;out.textContent='جارٍ التشخيص…';tbl.innerHTML='';
 try{const r=await fetch(O+'/diagnose?url='+encodeURIComponent(src()),{cache:'no-store'}),j=await r.json();out.textContent=JSON.stringify(j,null,2);
 let h='<table><tr><th>الجودة</th><th>الاختبار</th><th>HTTP</th><th>الزمن</th></tr>';
 for(const v of(j.variants||[]))for(const t of(v.tests||[])){const ok=t.status>=200&&t.status<300;h+='<tr><td>'+(v.quality||v.resolution||v.id)+'</td><td>'+t.name+'</td><td class="'+(ok?'ok':'bad')+'">'+(t.status||t.error||'-')+'</td><td>'+(t.latency_ms||'-')+' ms</td></tr>'}tbl.innerHTML=h+'</table>';
 }catch(e){out.textContent='Diagnostic error: '+e}}
</script></body></html>`}
