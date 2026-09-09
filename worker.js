// ==========================================
// الإعدادات والثوابت
// ==========================================
const LIVE_API_BASE = "http://live.sepdatabridge.site/api/live/livedrama/v13.0.0";
const REDIRECT_API_BASE = "http://redirect.sepdatabridge.site/redirect";

const AES_KEY_STRING = '0123456789abcdef';
const AES_IV_STRING = 'fedcba9876543210';
const IV_BASE64 = 'ZmVkY2JhOTg3NjU0MzIxMA==';

const API_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 16)",
    "Accept-Encoding": "gzip",
    "Connection": "Keep-Alive",
};

// ==========================================
// دوال التشفير المدمجة (Native Web Crypto API)
// ==========================================
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function getCryptoKey() {
    return await crypto.subtle.importKey(
        "raw",
        encoder.encode(AES_KEY_STRING),
        { name: "AES-CBC", length: 128 },
        false,
        ["encrypt", "decrypt"]
    );
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    let bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function base64ToArrayBuffer(base64) {
    let binary_string = atob(base64);
    let len = binary_string.length;
    let bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) bytes[i] = binary_string.charCodeAt(i);
    return bytes;
}

async function encryptPayload(jsonData) {
    const key = await getCryptoKey();
    const iv = encoder.encode(AES_IV_STRING);
    const data = encoder.encode(JSON.stringify(jsonData));
    const encryptedBuffer = await crypto.subtle.encrypt({ name: "AES-CBC", iv: iv }, key, data);
    return arrayBufferToBase64(encryptedBuffer) + ':' + IV_BASE64;
}

async function decryptPayload(encryptedText) {
    const ciphertextBase64 = encryptedText.split(':')[0];
    const key = await getCryptoKey();
    const iv = encoder.encode(AES_IV_STRING);
    const bytes = base64ToArrayBuffer(ciphertextBase64);
    const decryptedBuffer = await crypto.subtle.decrypt({ name: "AES-CBC", iv: iv }, key, bytes);
    return JSON.parse(decoder.decode(decryptedBuffer));
}

// ==========================================
// بناء الطلبات
// ==========================================
function commonPayload() {
    return {
        "user_id": `_41810_${Date.now()}_notloggedin.com_dramalive3`,
        "device_id": crypto.randomUUID(),
        "device_api": "36",
        "version_name": "186",
        "language": "ar",
        "timezone": "Asia/Baghdad",
        "device_type": "phone",
        "KEY_ACTIVATED_TYPE": "202122",
        "store": "playStore",
        "isStoreVersion": false,
        "isPremium": false,
        "isCoupon_active": false,
        "hideAds": false,
        "appCount": JSON.stringify({ adsFailed: 0, adsLoaded: 0, adsShowed: 0, runCount: 1 }),
        "mainServer": "http://main.backendcoreapi.com/api/live/livedrama/v13.0.0/",
    };
}

async function encryptedPost(url, data) {
    const body = await encryptPayload(data);
    const response = await fetch(url, { method: 'POST', headers: API_HEADERS, body: body });
    if (!response.ok) throw new Error(`API Error: ${response.status}`);
    const text = await response.text();
    return await decryptPayload(text);
}

// ==========================================
// جلب وحل السيرفرات
// ==========================================
async function resolveChannel(channelId, serverIndex = 0) {
    const payload = commonPayload();
    payload.id = channelId;
    const streamInfo = await encryptedPost(`${LIVE_API_BASE}/getLiveAllStreamsById`, payload);
    const live = streamInfo.live;
    if (!live) throw new Error("القناة غير موجودة");

    let options = [];
    if (live.url) options.push({ url: live.url, agent: live.agent || "redirect" });
    
    if (live.backup) {
        let backups = Array.isArray(live.backup) ? live.backup : live.backup.split("-;-");
        backups.forEach(b => {
            let parts = b.split(" -- ");
            options.push({ url: parts[0].trim(), agent: parts[1] ? parts[1].trim() : "redirect" });
        });
    }

    if (serverIndex >= options.length) throw new Error("السيرفر غير متوفر");
    let selected = options[serverIndex];
    let source = selected.url;
    let resolverAgent = selected.agent;
    let resolved = { url: source, agent: "", headers: {}, swap: {} };

    if (["redirect", "double_redirect", "all_streams_redirect"].includes(resolverAgent)) {
        let rPayload = commonPayload();
        rPayload.id = channelId; rPayload.url = source; rPayload.agent = resolverAgent;
        let rData = await encryptedPost(`${REDIRECT_API_BASE}/getLiveByRedirect`, rPayload);
        
        let nested = rData.data?.url || {};
        if (typeof nested === 'string') { try { nested = JSON.parse(nested); } catch(e) { nested = {url: nested}; } }
        
        let nextUrl = nested.url;
        let nextAgent = nested.agent || rData.data?.agent || "redirect";

        if (resolverAgent === "double_redirect" && nextUrl) {
            let rPayload2 = commonPayload();
            rPayload2.id = channelId; rPayload2.url = nextUrl; rPayload2.agent = nextAgent;
            try {
                let rData2 = await encryptedPost(`${REDIRECT_API_BASE}/getLiveByRedirect`, rPayload2);
                let nested2 = rData2.data?.url || {};
                if (typeof nested2 === 'string') { try { nested2 = JSON.parse(nested2); } catch(e) { nested2 = {url: nested2}; } }
                if (nested2.url) nested = nested2;
            } catch(e) {}
        }
        resolved.url = nested.url || resolved.url;
        resolved.agent = nested.agent || "";
        resolved.headers = nested.headers || {};
        resolved.swap = nested.swap || {};
    } else {
        try {
            let meta = JSON.parse(source);
            resolved.url = meta.url || source;
            resolved.headers = meta.headers || {};
            resolved.swap = meta.swap || {};
        } catch(e) {}
    }

    if (!resolved.url.startsWith('http')) throw new Error("رابط وهمي مكسور");
    return resolved;
}

// ==========================================
// التوكن وتعديل الروابط
// ==========================================
function encodeProxyToken(url, referer, userAgent, swap, type) {
    const data = JSON.stringify({ u: url, r: referer || "", a: userAgent || "", s: swap || {}, t: type });
    return arrayBufferToBase64(encoder.encode(data));
}

function decodeProxyToken(token) {
    return JSON.parse(decoder.decode(base64ToArrayBuffer(token)));
}

function applySwap(uri, swapConfig) {
    let result = uri;
    if (swapConfig && typeof swapConfig === 'object') {
        for (const [key, value] of Object.entries(swapConfig)) {
            if (key) result = result.replace(key, value || "");
        }
    }
    return result;
}

function rewriteManifest(manifestText, baseUrl, referer, agent, swap, workerOrigin) {
    let lines = manifestText.split('\n');
    let out = [];
    for (let line of lines) {
        let trimmed = line.trim();
        if (!trimmed) continue;
        
        if (trimmed.startsWith("#")) {
            let replaced = trimmed.replace(/URI="(.*?)"/g, (match, uri) => {
                let swappedUri = applySwap(uri, swap);
                let absoluteUrl = new URL(swappedUri, baseUrl).href;
                let isManifest = absoluteUrl.includes('.m3u8') || absoluteUrl.includes('.mpd');
                let token = encodeProxyToken(absoluteUrl, referer, agent, swap, isManifest ? 'm' : 's');
                return `URI="${workerOrigin}/proxy?t=${encodeURIComponent(token)}"`;
            });
            out.push(replaced);
        } else {
            let swappedUri = applySwap(trimmed, swap);
            let absoluteUrl = new URL(swappedUri, baseUrl).href;
            let isManifest = absoluteUrl.includes('.m3u8') || absoluteUrl.includes('.mpd');
            let token = encodeProxyToken(absoluteUrl, referer, agent, swap, isManifest ? 'm' : 's');
            out.push(`${workerOrigin}/proxy?t=${encodeURIComponent(token)}`);
        }
    }
    return out.join('\n');
}

// ==========================================
// معالج الطلبات (Cloudflare Worker)
// ==========================================
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const workerOrigin = url.origin;

        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Range, Accept",
            "Access-Control-Expose-Headers": "Content-Length, Content-Range",
        };
        
        if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

        try {
            // ----------------------------------------------------
            // 1. مسار التشغيل: /play/:channel_id
            // ----------------------------------------------------
            if (path.startsWith("/play/")) {
                const channelId = path.split("/")[2];
                const isRawRequested = url.searchParams.get("raw") === "1";
                const acceptHeader = request.headers.get("Accept") || "";

                // مشغل الويب المُحسن (يظهر أخطاء الشبكة فوراً إن وجدت)
                if (!isRawRequested && acceptHeader.includes("text/html")) {
                    const streamUrl = `${workerOrigin}/play/${channelId}?raw=1`;
                    const html = `<!DOCTYPE html>
                    <html lang="ar" dir="rtl"><head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <title>Enlil IPTV Web Player</title>
                    <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
                    <style>
                      body{margin:0;background:#000;display:flex;justify-content:center;align-items:center;height:100vh;} 
                      video{width:100%;height:100%;outline:none;}
                      #err{position:absolute;top:20px;color:red;font-weight:bold;z-index:99;background:rgba(0,0,0,0.7);padding:10px;border-radius:8px;display:none;}
                    </style>
                    </head><body>
                    <div id="err"></div>
                    <video id="video" controls autoplay playsinline></video>
                    <script>
                      var video = document.getElementById('video');
                      var errBox = document.getElementById('err');
                      var hlsUrl = '${streamUrl}';
                      if (Hls.isSupported()) {
                        var hls = new Hls({maxMaxBufferLength: 30});
                        hls.loadSource(hlsUrl);
                        hls.attachMedia(video);
                        hls.on(Hls.Events.MANIFEST_PARSED, function() { video.play().catch(e=>{}); });
                        hls.on(Hls.Events.ERROR, function (event, data) {
                          if (data.fatal) {
                            errBox.style.display = 'block';
                            errBox.innerText = 'خطأ في تشغيل المقطع: ' + data.details;
                            if(data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
                          }
                        });
                      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                        video.src = hlsUrl;
                        video.addEventListener('loadedmetadata', function() { video.play().catch(e=>{}); });
                      }
                    </script>
                    </body></html>`;
                    return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8", ...corsHeaders }});
                }

                // النظام القناص (Failover)
                let serverCount = 8; 
                for (let i = 0; i < serverCount; i++) {
                    try {
                        const info = await resolveChannel(channelId, i);
                        const targetUrl = info.url;
                        const referer = info.headers.Referer || `https://${new URL(targetUrl).hostname}/`;
                        const userAgent = info.agent || "ExoPlayer/2.18.1 (Linux; Android 13) ExoPlayerLib/2.18.1";
                        const swap = info.swap || {};

                        let fetchHeaders = new Headers({ "User-Agent": userAgent, "Referer": referer, "Origin": new URL(referer).origin });
                        let response = await fetch(targetUrl, { headers: fetchHeaders, redirect: "follow" });
                        
                        if (response.ok) {
                            let contentType = response.headers.get("content-type") || "";
                            if (contentType.includes("mpegurl") || targetUrl.includes(".m3u8")) {
                                let manifestText = await response.text();
                                let rewritten = rewriteManifest(manifestText, response.url, referer, userAgent, swap, workerOrigin);
                                return new Response(rewritten, {
                                    status: 200,
                                    headers: { ...corsHeaders, "Content-Type": "application/vnd.apple.mpegurl" }
                                });
                            } else {
                                return Response.redirect(targetUrl, 302);
                            }
                        }
                    } catch (err) {
                        continue;
                    }
                }
                return new Response("عذراً، جميع السيرفرات معطلة حالياً.", { status: 502, headers: corsHeaders });
            }

            // ----------------------------------------------------
            // 2. وكيل المقاطع (Segments Proxy) وإجبار الصيغة الصحيحة
            // ----------------------------------------------------
            if (path === "/proxy") {
                const token = url.searchParams.get("t");
                if (!token) return new Response("Missing token", { status: 400 });

                const proxyData = decodeProxyToken(token);
                const targetUrl = proxyData.u;
                const type = proxyData.t; 
                
                const fetchHeaders = new Headers();
                fetchHeaders.set("User-Agent", proxyData.a);
                if (proxyData.r) {
                    fetchHeaders.set("Referer", proxyData.r);
                    fetchHeaders.set("Origin", new URL(proxyData.r).origin);
                }
                if (request.headers.has("Range")) fetchHeaders.set("Range", request.headers.get("Range"));

                const response = await fetch(targetUrl, { method: request.method, headers: fetchHeaders, redirect: "follow" });

                if (type === 'm') {
                    let manifestText = await response.text();
                    let rewritten = rewriteManifest(manifestText, response.url, proxyData.r, proxyData.a, proxyData.s, workerOrigin);
                    return new Response(rewritten, { status: 200, headers: { ...corsHeaders, "Content-Type": "application/vnd.apple.mpegurl" }});
                }

                // للمقاطع: إجبار الصيغة الصحيحة لتشغيل ملفات الـ .js الوهمية كفيديو
                const newHeaders = new Headers(response.headers);
                newHeaders.set("Access-Control-Allow-Origin", "*");
                newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
                newHeaders.set("Access-Control-Allow-Headers", "Content-Type, Range, Accept");
                newHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");
                newHeaders.delete("content-encoding");
                newHeaders.delete("transfer-encoding");

                let pathLower = targetUrl.toLowerCase();
                if (pathLower.includes(".js") || pathLower.includes(".ts")) {
                    newHeaders.set("Content-Type", "video/mp2t"); // تحويل الـ JS إلى فيديو
                } else if (pathLower.includes(".m4s")) {
                    newHeaders.set("Content-Type", "video/iso.segment");
                }

                return new Response(response.body, { status: response.status, headers: newHeaders });
            }

            return new Response("Enlil IPTV Server Running", { status: 200 });

        } catch (error) {
            return new Response(error.message, { status: 500, headers: corsHeaders });
        }
    }
};
