/**
 * Enlil Tmax HLS Worker v1.0
 * Single-file Cloudflare Worker.
 * Use with HLS sources you own or are authorized to proxy.
 */
const VERSION="2.0.0";
const UA="Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152 Mobile Safari/537.36";

export default {async fetch(req){
  try{
    const u=new URL(req.url);
    if(req.method==="OPTIONS") return cors(new Response(null,{status:204}));
    if(u.pathname==="/health") return json({ok:true,version:VERSION});
    if(u.pathname==="/info") return info(req);
    if(u.pathname==="/play") return play(req);
    if(u.pathname==="/resource") return resource(req);
    return new Response(home(u.origin),{headers:{"content-type":"text/html;charset=UTF-8"}});
  }catch(e){return json({ok:false,error:String(e?.message||e)},500)}
}};

function valid(s){
  const u=new URL(s); if(!["http:","https:"].includes(u.protocol)) throw Error("HTTP/HTTPS only");
  const h=u.hostname.toLowerCase();
  if(h==="localhost"||h==="127.0.0.1"||h==="::1"||h.endsWith(".local")||
     /^10\./.test(h)||/^192\.168\./.test(h)||/^172\.(1[6-9]|2\d|3[01])\./.test(h)||/^169\.254\./.test(h))
    throw Error("Private/local destination blocked");
  return u;
}
function headers(req,ref=""){
  const h=new Headers({"User-Agent":UA,"Accept":"*/*","Accept-Encoding":"identity"});
  if(ref)h.set("Referer",ref); const r=req.headers.get("Range"); if(r)h.set("Range",r); return h;
}
async function get(req,url,ref=""){valid(url);return fetch(url,{headers:headers(req,ref),redirect:"follow"})}
function attrs(line){const o={};for(const m of line.slice(line.indexOf(":")+1).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g))o[m[1]]=m[2].replace(/^"|"$/g,"");return o}
function variants(text,base){
  const l=text.split(/\r?\n/),o=[];
  for(let i=0;i<l.length;i++)if(l[i].trim().startsWith("#EXT-X-STREAM-INF")){
    let j=i+1;while(j<l.length&&(!l[j].trim()||l[j].trim().startsWith("#")))j++;
    if(j>=l.length)continue;const a=attrs(l[i]),res=(a.RESOLUTION||"").replace("×","x"),p=res.split("x");
    const height=p.length>1?Number(p[p.length-1]):null;
    o.push({id:o.length+1,height:Number.isFinite(height)?height:null,resolution:res||null,bandwidth:Number(a.BANDWIDTH)||null,url:new URL(l[j].trim(),base).href});
  }return o;
}
function isMaster(t){return /#EXT-X-STREAM-INF:/i.test(t)}
function px(origin,url,ref=""){const x=new URL(origin+"/resource");x.searchParams.set("u",url);if(ref)x.searchParams.set("r",ref);return x.href}
function rewrite(text,base,origin){
  return text.split(/\r?\n/).map(line=>{
    const s=line.trim();if(!s)return line;
    if(s.startsWith("#")&&/URI="[^"]+"/i.test(line))return line.replace(/URI="([^"]+)"/g,(_,x)=>`URI="${px(origin,new URL(x,base).href,base)}"`);
    if(s.startsWith("#"))return line;
    return px(origin,new URL(s,base).href,base);
  }).join("\n");
}
async function manifest(req,url,ref=""){
  const r=await get(req,url,ref),t=await r.text();
  if(!r.ok)throw Error(`HTTP ${r.status}`);if(!t.trimStart().startsWith("#EXTM3U"))throw Error("Not HLS");
  return {r,t,url:r.url};
}
function pick(v,q){
  if(q==="auto"||!q)return [...v].sort((a,b)=>(a.bandwidth??9e15)-(b.bandwidth??9e15));
  const n=Number(q.replace(/\D/g,""));const exact=v.find(x=>x.height===n);
  return exact?[exact]:[...v].sort((a,b)=>Math.abs((a.height??99999)-n)-Math.abs((b.height??99999)-n)).slice(0,1);
}

async function diagnose(req){
  const u=new URL(req.url),src=u.searchParams.get("url");
  if(!src)return json({ok:false,error:"Missing ?url="},400);
  try{
    const t0=Date.now(),mr=await get(req,src),text=await mr.clone().text();
    const out={ok:true,version:VERSION,master:{status:mr.status,final_url:mr.url,latency_ms:Date.now()-t0,content_type:mr.headers.get("content-type"),is_hls:text.trimStart().startsWith("#EXTM3U"),is_master:isMaster(text)},variants:[]};
    if(!mr.ok||!out.master.is_hls)return json(out);
    for(const v of variants(text,mr.url)){
      const tests=[];
      for(const shape of [{name:"default",ref:""},{name:"master-referer",ref:mr.url}]){
        const ts=Date.now();
        try{
          const r=await get(req,v.url,shape.ref),preview=r.ok?"":(await r.clone().text()).slice(0,240).replace(/\\s+/g," ");
          tests.push({name:shape.name,status:r.status,final_url:r.url,latency_ms:Date.now()-ts,content_type:r.headers.get("content-type"),server:r.headers.get("server"),location:r.headers.get("location"),www_authenticate:r.headers.get("www-authenticate"),body_preview:preview});
        }catch(e){tests.push({name:shape.name,error:String(e?.message||e),latency_ms:Date.now()-ts})}
      }
      out.variants.push({id:v.id,quality:v.height,resolution:v.resolution,bandwidth:v.bandwidth,url:v.url,tests});
    }
    return json(out);
  }catch(e){return json({ok:false,error:String(e?.message||e)},502)}
}
async function info(req){
  const u=new URL(req.url),src=u.searchParams.get("url");if(!src)return json({ok:false,error:"Missing url"},400);
  try{const m=await manifest(req,src),v=isMaster(m.t)?variants(m.t,m.url):[];
    return json({ok:true,type:isMaster(m.t)?"master":"media",qualities:v.map(x=>({q:x.height||x.id,resolution:x.resolution,bandwidth:x.bandwidth}))});
  }catch(e){return json({ok:false,error:String(e.message||e)},502)}
}
async function play(req){
  const u=new URL(req.url),src=u.searchParams.get("url"),q=(u.searchParams.get("q")||"auto").toLowerCase();
  if(!src)return json({ok:false,error:"Missing url"},400);
  try{
    const m=await manifest(req,src);
    if(!isMaster(m.t))return m3u8(rewrite(m.t,m.url,u.origin),{"X-Enlil-Mode":"media"});
    const v=variants(m.t,m.url);if(!v.length)throw Error("No variants");
    if(q==="master")return m3u8(rewrite(m.t,m.url,u.origin),{"X-Enlil-Mode":"master"});
    const choices=pick(v,q); if(q==="auto") for(const x of v)if(!choices.includes(x))choices.push(x);
    let last="No playable variant";
    for(const x of choices)try{
      const vr=await manifest(req,x.url,m.url);
      return m3u8(rewrite(vr.t,vr.url,u.origin),{"X-Enlil-Mode":"pinned","X-Enlil-Quality":String(x.height||x.id)});
    }catch(e){last=String(e.message||e)}
    throw Error(last);
  }catch(e){return json({ok:false,error:String(e.message||e)},502)}
}
async function resource(req){
  const u=new URL(req.url),target=u.searchParams.get("u"),ref=u.searchParams.get("r")||"";
  if(!target)return json({ok:false,error:"Missing resource"},400);
  try{
    const r=await get(req,target,ref),ct=(r.headers.get("content-type")||"").toLowerCase();
    if(ct.includes("mpegurl")||new URL(r.url).pathname.toLowerCase().endsWith(".m3u8")){
      const t=await r.text();if(!r.ok)throw Error(`HTTP ${r.status}`);return m3u8(rewrite(t,r.url,u.origin));
    }
    const h=new Headers({"Access-Control-Allow-Origin":"*","Cache-Control":"no-store","Content-Type":r.headers.get("content-type")||"application/octet-stream"});
    for(const k of ["content-range","accept-ranges","etag","last-modified"]){const v=r.headers.get(k);if(v)h.set(k,v)}
    return new Response(r.body,{status:r.status,headers:h});
  }catch(e){return json({ok:false,error:String(e.message||e)},502)}
}
function m3u8(t,x={}){return new Response(t,{headers:{"Content-Type":"application/vnd.apple.mpegurl;charset=UTF-8","Access-Control-Allow-Origin":"*","Cache-Control":"no-store",...x}})}
function cors(r){const h=new Headers(r.headers);h.set("Access-Control-Allow-Origin","*");h.set("Access-Control-Allow-Headers","Range, Content-Type");h.set("Access-Control-Allow-Methods","GET,HEAD,OPTIONS");return new Response(r.body,{status:r.status,headers:h})}
function json(x,s=200){return cors(new Response(JSON.stringify(x,null,2),{status:s,headers:{"content-type":"application/json;charset=UTF-8"}}))}
function home(origin){return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Enlil HLS Worker</title><style>body{font-family:system-ui;background:#09101a;color:#eef3fb;margin:0}main{max-width:760px;margin:8vh auto;padding:18px}.c{background:#111b2a;border:1px solid #293a55;border-radius:18px;padding:20px}input,select,button{width:100%;padding:13px;margin:7px 0;border-radius:12px;border:1px solid #304461;background:#0a1321;color:#fff}button{cursor:pointer}.o{direction:ltr;text-align:left;word-break:break-all;background:#070c14;padding:12px;border-radius:12px;margin-top:10px}</style><main><div class="c"><h2>Enlil HLS Worker</h2><input id="s" dir="ltr" placeholder="https://...m3u8"><select id="q"><option value="auto">Auto — أول جودة تعمل</option><option value="master">Master — جميع الجودات</option><option value="480">480p</option><option value="720">720p</option><option value="1080">1080p</option></select><button onclick="go()">إنشاء M3U8</button><div id="o" class="o"></div><script>function go(){let s=document.getElementById("s").value.trim(),q=document.getElementById("q").value;document.getElementById("o").textContent=s?'${origin}/play?url='+encodeURIComponent(s)+'&q='+q:'أدخل الرابط'}</script></div></main></html>`}
