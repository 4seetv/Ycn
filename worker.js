/**
 * Enlil Redline Channel Index + Resolver
 * Single-file Cloudflare Worker
 *
 * Admin index PIN: 2180
 * Playback URLs remain public so native players can follow redirects.
 */

const ADMIN_PIN = "2180";
const DEVICE_MAC = "02:00:00:00:00:00";
const DEVICE_CODE = "RDLNB89BED0248FA";
const XOR_KEY = "KCQ";
const REDLINE_UA = "Rediptv 2.0.74";

const CHANNELS = [{"id":"1","slug":"bein-sports","title":"beIN SPORTS","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsHD.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/544e2f6265696e73706f72747368642d6172/1"},{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/54522d4e2f6265494e5f53706f7274735f48442d6172/1"}]},{"id":"2","slug":"bein-sports-news","title":"beIN SPORTS NEWS","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsNewsHD.png","servers":[{"name":"سيرفر جديد","url":"http://play.redroidiptv.com/live/hls/20/US/544e2f6265696e73706f7274736e65777368642d6172/1"}]},{"id":"3","slug":"bein-sports-1","title":"beIN SPORTS 1","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSports1.png","servers":[{"name":"SD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473315f53442d6172/1"},{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473315f48442d6172/1"},{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473315f4648442d6172/1"}]},{"id":"4","slug":"bein-sports-2","title":"beIN SPORTS 2","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSports2.png","servers":[{"name":"SD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473325f53442d6172/1"},{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473325f48442d6172/1"},{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473325f4648442d6172/1"}]},{"id":"5","slug":"bein-sports-3","title":"beIN SPORTS 3","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSports3.png","servers":[{"name":"SD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473335f53442d6172/1"},{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473335f48442d6172/1"},{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473335f4648442d6172/1"}]},{"id":"6","slug":"bein-sports-4","title":"beIN SPORTS 4","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSports4.png","servers":[{"name":"SD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473345f53442d6172/1"},{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473345f48442d6172/1"},{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473345f4648442d6172/1"}]},{"id":"7","slug":"bein-sports-5","title":"beIN SPORTS 5","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSports5.png","servers":[{"name":"SD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473355f53442d6172/1"},{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473355f48442d6172/1"},{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473355f4648442d6172/1"}]},{"id":"8","slug":"bein-sports-6","title":"beIN SPORTS 6","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSports6.png","servers":[{"name":"SD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473365f53442d6172/1"},{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473365f48442d6172/1"},{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473365f4648442d6172/1"}]},{"id":"9","slug":"bein-sports-7","title":"beIN SPORTS 7","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSports7.png","servers":[{"name":"SD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473375f53442d6172/1"},{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473375f48442d6172/1"},{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f727473375f4648442d6172/1"}]},{"id":"10","slug":"bein-sports-8","title":"beIN SPORTS 8","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSports8.png","servers":[{"name":"SD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f7274735f385f53442d6172/1"},{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f7274735f385f48442d6172/1"},{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f7274735f385f4648442d6172/1"}]},{"id":"11","slug":"bein-sports-9","title":"beIN SPORTS 9","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSports9.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f7274735f395f48442d6172/1"}]},{"id":"12","slug":"bein-sports-1-english","title":"beIN SPORTS 1 English","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsEnglish1.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f7274735f456e676c697368315f48442d6172/1"}]},{"id":"13","slug":"bein-sports-2-english","title":"beIN SPORTS 2 English","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsEnglish2.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f7274735f456e676c697368325f48442d6172/1"}]},{"id":"14","slug":"bein-sports-french-1","title":"beIN Sports French 1","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsFrench1.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f7274735f4672656e6368315f48442d6172/1"}]},{"id":"15","slug":"bein-sports-french-2","title":"beIN Sports French 2","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsFrench2.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f7274735f4672656e6368325f48442d6172/1"}]},{"id":"16","slug":"bein-sports-french-3","title":"beIN Sports French 3","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsFrench3.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f7274735f4672656e6368335f48442d6172/1"}]},{"id":"17","slug":"bein-sports-nba","title":"beIN SPORTS NBA","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsNBA.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f53706f7274735f4e42415f48442d6172/1"}]},{"id":"18","slug":"bein-sports-xtra-1","title":"beIN Sports Xtra 1","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsXtra1.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f58747261315f48442d6172/1"}]},{"id":"19","slug":"bein-sports-xtra-2","title":"beIN Sports Xtra 2","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsXtra2.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f58747261325f48442d6172/1"}]},{"id":"20","slug":"bein-sports-xtra-3","title":"beIN Sports Xtra 3","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsXtra.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/506c75732f6265494e5f58747261335f48442d6172/1"}]},{"id":"21","slug":"bein-sports-xtra-4","title":"beIN Sports Xtra 4","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsXtra.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/495354522f6265494e5f58747261345f48442d6172/1"}]},{"id":"22","slug":"bein-sports-xtra-5","title":"beIN Sports Xtra 5","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsXtra.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/495354522f6265494e5f58747261355f48442d6172/1"}]},{"id":"23","slug":"bein-sports-xtra-6","title":"beIN Sports Xtra 6","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsXtra.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/495354522f6265494e5f58747261365f48442d6172/1"}]},{"id":"24","slug":"bein-sports-xtra-7","title":"beIN Sports Xtra 7","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsXtra.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/495354522f6265494e5f58747261375f48442d6172/1"}]},{"id":"25","slug":"bein-sports-xtra-8","title":"beIN Sports Xtra 8","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsXtra.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/495354522f6265494e5f58747261385f48442d6172/1"}]},{"id":"26","slug":"bein-sports-xtra-9","title":"beIN Sports Xtra 9","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsXtra.png","servers":[{"name":"HD","url":"http://play.redroidiptv.com/live/hls/20/US/495354522f6265494e5f58747261395f48442d6172/1"}]},{"id":"27","slug":"bein-sports-haber","title":"beIN Sports Haber","logo":"https://f.cdnrdn.com/files/icons/International/beIN/beINSportsHaber.png","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/54522d4e2f6265494e5f53504f5254535f48414245525f48442d7472/1"}]},{"id":"28","slug":"trt-4k","title":"TRT 4K","logo":"https://f.cdnrdn.com/files/icons/Countries/TR/TRT4K.png","servers":[{"name":"4K","url":"http://play.redroidiptv.com/live/hls/20/US/54522d4e2f5452545f344b2d7472/1"}]},{"id":"29","slug":"espn-4k","title":"ESPN 4K","logo":"https://f.cdnrdn.com/files/icons/International/ESPN/ESPN.png","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/30/US/4252582f4553504e5f344b/1"}]},{"id":"30","slug":"espn2-4k","title":"ESPN2 4K","logo":"https://f.cdnrdn.com/files/icons/International/ESPN/ESPN2.png","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/30/US/4252582f4553504e325f346b/1"}]},{"id":"31","slug":"espn3-4k","title":"ESPN3 4K","logo":"https://f.cdnrdn.com/files/icons/International/ESPN/ESPN3.png","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/30/US/4252582f4553504e335f346b/1"}]},{"id":"32","slug":"espn4-4k","title":"ESPN4 4K","logo":"https://f.cdnrdn.com/files/icons/International/ESPN/ESPN4.png","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/30/US/4252582f4553504e345f346b/1"}]},{"id":"33","slug":"espn5-4k","title":"ESPN5 4K","logo":"https://f.cdnrdn.com/files/icons/International/ESPN/ESPN5.png","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/30/US/4252582f4553504e355f346b/1"}]},{"id":"34","slug":"espn6-4k","title":"ESPN6 4K","logo":"https://f.cdnrdn.com/files/icons/International/ESPN/ESPN6.png","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/30/US/4252582f4553504e365f346b/1"}]},{"id":"35","slug":"wwe-channel","title":"WWE Channel","logo":"https://f.cdnrdn.com/files/icons/Countries/US/WWENetwork.png","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/4146522d45582f537570657253706f72745f5757455f4648442d64737476/1"}]},{"id":"36","slug":"starzplay-sport-1","title":"STARZPLAY Sport 1","logo":"https://f.cdnrdn.com/files/icons/Countries/AE/AbuDhabiSports1Premium.png","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/45582f414453706f7274315072656d69756d5f4648442d6172/1"}]},{"id":"37","slug":"starzplay-sport-2","title":"STARZPLAY Sport 2","logo":"https://f.cdnrdn.com/files/icons/Countries/AE/AbuDhabiSports2Premium.png","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/45582f414453706f7274325072656d69756d5f4648442d6172/1"}]},{"id":"38","slug":"starzplay-sport-3","title":"STARZPLAY Sport 3","logo":"https://f.cdnrdn.com/files/icons/Countries/AE/AbuDhabiSports3.png","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/45582f414453706f7274335072656d69756d5f4648442d6172/1"}]},{"id":"39","slug":"starzplay-ad-sport-asia-1","title":"STARZPLAY AD SPORT ASIA 1","logo":"","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/45582f537461727a5f506c61795f53504f52545f417369615f30315f4648442d6172/1"}]},{"id":"40","slug":"starzplay-ad-sport-asia-2","title":"STARZPLAY AD SPORT ASIA 2","logo":"","servers":[{"name":"FHD","url":"http://play.redroidiptv.com/live/hls/20/US/45582f537461727a5f506c61795f53504f52545f417369615f30325f4648442d6172/1"}]}];

function utf8(text){ return new TextEncoder().encode(text); }
function bytesToBase64(bytes){
  let s="";
  for(let i=0;i<bytes.length;i++) s+=String.fromCharCode(bytes[i]);
  return btoa(s);
}
function generateRAuth(){
  const ts=Math.floor(Date.now()/1000);
  const raw=DEVICE_MAC+"\x02|"+DEVICE_CODE+"\x02|"+String(ts);
  const input=utf8(raw), key=utf8(XOR_KEY), out=new Uint8Array(input.length);
  for(let i=0;i<input.length;i++) out[i]=input[i]^key[i%key.length];
  return bytesToBase64(out);
}
function redlineHeaders(){
  return {
    "User-Agent":REDLINE_UA,
    "R-Auth":generateRAuth(),
    "Accept":"*/*",
    "Accept-Encoding":"identity"
  };
}
function cors(extra={}){
  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers":"*",
    ...extra
  };
}
function json(data,status=200){
  return new Response(JSON.stringify(data,null,2),{
    status,
    headers:cors({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"})
  });
}
function esc(s){
  return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
function cookieValue(request,name){
  const c=request.headers.get("Cookie")||"";
  for(const part of c.split(";")){
    const p=part.trim();
    if(p.startsWith(name+"=")) return decodeURIComponent(p.slice(name.length+1));
  }
  return "";
}
function isLoggedIn(request){ return cookieValue(request,"enlil_admin")==="1"; }

async function resolveServer(server){
  const r=await fetch(server.url,{
    method:"GET",
    headers:redlineHeaders(),
    redirect:"manual"
  });
  if(r.status>=300 && r.status<400){
    const location=r.headers.get("location");
    if(!location) throw new Error("Redline redirect has no Location header");
    return location;
  }
  let preview="";
  try{ preview=(await r.text()).slice(0,400); }catch(_){}
  throw new Error(`Redline HTTP ${r.status}${preview?": "+preview:""}`);
}

function findChannel(slug){ return CHANNELS.find(c=>c.slug===slug); }

function loginPage(error=""){
  return new Response(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enlil Redline</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#080b12;color:#eef2ff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.card{width:min(92vw,390px);padding:28px;border:1px solid #242b3b;border-radius:24px;background:#101521;box-shadow:0 24px 70px #0008}
h1{margin:0 0 8px;font-size:25px}.muted{color:#9aa5ba;margin:0 0 22px}.err{color:#ff9b9b;margin:0 0 12px}
input,button{width:100%;border-radius:14px;padding:14px 15px;font-size:16px}input{background:#090d15;border:1px solid #30394d;color:white;outline:none}button{margin-top:12px;border:0;background:#f1f5ff;color:#080b12;font-weight:800;cursor:pointer}
</style></head><body><form class="card" method="post" action="/login">
<h1>Enlil Redline</h1><p class="muted">لوحة روابط القنوات الخاصة</p>
${error?`<p class="err">${esc(error)}</p>`:""}
<input name="pin" type="password" inputmode="numeric" placeholder="الرمز السري" autofocus required>
<button type="submit">دخول</button></form></body></html>`,{
    headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}
  });
}

function dashboard(origin){
  const cards=CHANNELS.map(ch=>{
    const servers=ch.servers.map((s,i)=>{
      const path=`/live/${encodeURIComponent(ch.slug)}/${i+1}.m3u8`;
      const full=origin+path;
      return `<div class="server">
        <div><b>${esc(s.name)}</b><small>Server ${i+1}</small></div>
        <input readonly value="${esc(full)}">
        <button class="copy" data-url="${esc(full)}">نسخ</button>
        <a class="open" href="${esc(path)}" target="_blank">فتح</a>
      </div>`;
    }).join("");
    return `<article class="channel" data-search="${esc((ch.title+" "+ch.slug).toLowerCase())}">
      <div class="head">
        ${ch.logo?`<img src="${esc(ch.logo)}" loading="lazy" referrerpolicy="no-referrer">`:`<div class="ph">TV</div>`}
        <div><h2>${esc(ch.title)}</h2><span>${ch.servers.length} سيرفر</span></div>
      </div>${servers}
    </article>`;
  }).join("");

  return new Response(`<!doctype html>
<html lang="ar" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enlil Redline Index</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#080b12;color:#edf2ff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{max-width:1100px;margin:auto;padding:20px}.top{position:sticky;top:0;z-index:5;background:#080b12eF;backdrop-filter:blur(14px);padding:12px 0 18px}
.row{display:flex;gap:12px;align-items:center;justify-content:space-between}.brand h1{font-size:23px;margin:0}.brand p{margin:4px 0 0;color:#8f9bb0;font-size:13px}
.search{width:100%;margin-top:14px;padding:14px 16px;border-radius:15px;border:1px solid #293247;background:#0e1420;color:#fff;font-size:16px;outline:none}
.logout{color:#cbd5e1;text-decoration:none;border:1px solid #2a3448;padding:9px 12px;border-radius:12px;font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
.channel{background:#101622;border:1px solid #202a3b;border-radius:20px;padding:15px}.head{display:flex;align-items:center;gap:12px;margin-bottom:14px}.head img,.ph{width:54px;height:54px;border-radius:14px;object-fit:contain;background:#fff;padding:5px}.ph{display:grid;place-items:center;background:#1d2636;color:#94a3b8;font-weight:900}
h2{font-size:17px;margin:0 0 4px}.head span,small{color:#8995aa;font-size:12px}.server{display:grid;grid-template-columns:90px 1fr 62px 52px;gap:7px;align-items:center;padding:9px 0;border-top:1px solid #1d2635}.server div{display:flex;flex-direction:column}.server input{min-width:0;background:#090e17;border:1px solid #273146;border-radius:10px;color:#b9c5d9;padding:9px;font-size:11px;direction:ltr}
.copy,.open{border:0;border-radius:10px;padding:9px 7px;text-align:center;text-decoration:none;font-weight:700;font-size:12px;cursor:pointer}.copy{background:#e9efff;color:#0a0e16}.open{background:#1b2638;color:#d9e5ff}
.empty{text-align:center;color:#8995aa;padding:40px;display:none}
@media(max-width:620px){.wrap{padding:12px}.grid{grid-template-columns:1fr}.server{grid-template-columns:72px 1fr 55px}.open{display:none}.channel{padding:12px}}
</style></head><body><main class="wrap">
<div class="top"><div class="row"><div class="brand"><h1>Enlil Redline</h1><p>${CHANNELS.length} قناة • فهرس خاص</p></div><a class="logout" href="/logout">خروج</a></div>
<input id="q" class="search" placeholder="ابحث عن قناة..." autocomplete="off"></div>
<section id="grid" class="grid">${cards}</section><div id="empty" class="empty">لا توجد نتائج</div>
</main>
<script>
const q=document.getElementById("q"), cards=[...document.querySelectorAll(".channel")], empty=document.getElementById("empty");
q.addEventListener("input",()=>{const v=q.value.trim().toLowerCase();let n=0;cards.forEach(c=>{const ok=!v||c.dataset.search.includes(v);c.style.display=ok?"":"none";if(ok)n++});empty.style.display=n?"none":"block"});
document.addEventListener("click",async e=>{const b=e.target.closest(".copy");if(!b)return;try{await navigator.clipboard.writeText(b.dataset.url);const old=b.textContent;b.textContent="تم";setTimeout(()=>b.textContent=old,900)}catch(_){prompt("انسخ الرابط:",b.dataset.url)}});
</script></body></html>`,{
    headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}
  });
}

export default {
  async fetch(request){
    const url=new URL(request.url), p=url.pathname;

    if(request.method==="OPTIONS") return new Response(null,{status:204,headers:cors()});

    if(p==="/login" && request.method==="POST"){
      const form=await request.formData();
      if(String(form.get("pin")||"")!==ADMIN_PIN) return loginPage("الرمز غير صحيح");
      return new Response(null,{status:303,headers:{
        "Location":"/",
        "Set-Cookie":"enlil_admin=1; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=86400",
        "Cache-Control":"no-store"
      }});
    }

    if(p==="/logout"){
      return new Response(null,{status:303,headers:{
        "Location":"/",
        "Set-Cookie":"enlil_admin=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"
      }});
    }

    if(p==="/health") return json({ok:true,service:"Enlil Redline Resolver",channels:CHANNELS.length,time:new Date().toISOString()});

    const live=p.match(/^\/live\/([^/]+)\/(\d+)\.m3u8$/);
    if(live){
      const slug=decodeURIComponent(live[1]);
      const idx=Number(live[2])-1;
      const ch=findChannel(slug);
      if(!ch || !ch.servers[idx]) return json({ok:false,error:"Channel/server not found"},404);
      try{
        const location=await resolveServer(ch.servers[idx]);
        return new Response(null,{status:302,headers:cors({
          "Location":location,
          "Cache-Control":"no-store"
        })});
      }catch(e){
        return json({ok:false,error:e?.message||String(e)},502);
      }
    }

    if(p==="/api/index"){
      if(!isLoggedIn(request)) return json({ok:false,error:"Unauthorized"},401);
      return json(CHANNELS.map(ch=>({
        id:ch.id,slug:ch.slug,title:ch.title,logo:ch.logo,
        servers:ch.servers.map((s,i)=>({name:s.name,url:`${url.origin}/live/${ch.slug}/${i+1}.m3u8`}))
      })));
    }

    if(p==="/" || p===""){
      if(!isLoggedIn(request)) return loginPage();
      return dashboard(url.origin);
    }

    return json({ok:false,error:"Route not found"},404);
  }
};
