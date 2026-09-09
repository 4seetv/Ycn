import CryptoJS from 'https://esm.sh/crypto-js@4.1.1';

// ==========================================
// الإعدادات والثوابت
// ==========================================
const LIVE_API_BASE = "http://live.sepdatabridge.site/api/live/livedrama/v13.0.0";
const REDIRECT_API_BASE = "http://redirect.sepdatabridge.site/redirect";

const AES_KEY = CryptoJS.enc.Utf8.parse('0123456789abcdef');
const AES_IV = CryptoJS.enc.Utf8.parse('fedcba9876543210');
const IV_BASE64 = 'ZmVkY2JhOTg3NjU0MzIxMA==';

const API_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "Dalvik/2.1.0 (Linux; U; Android 16)",
    "Accept-Encoding": "gzip",
    "Connection": "Keep-Alive",
};

// ==========================================
// دوال التشفير الخاصة بـ Drama Live
// ==========================================
function encryptPayload(jsonData) {
    const jsonString = JSON.stringify(jsonData);
    const encrypted = CryptoJS.AES.encrypt(jsonString, AES_KEY, {
        iv: AES_IV,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
    });
    return encrypted.toString() + ':' + IV_BASE64;
}

function decryptPayload(encryptedText) {
    const ciphertext = encryptedText.split(':')[0];
    const decrypted = CryptoJS.AES.decrypt(ciphertext, AES_KEY, {
        iv: AES_IV,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
    });
    return JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
}

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
    const body = encryptPayload(data);
    const response = await fetch(url, {
        method: 'POST',
        headers: API_HEADERS,
        body: body
    });
    if (!response.ok) throw new Error(`API Error: ${response.status}`);
    const text = await response.text();
    return decryptPayload(text);
}

// ==========================================
// دوال جلب السيرفرات والتوجيه (Resolver)
// ==========================================
async function resolveChannel(channelId, serverIndex = 0) {
    // 1. جلب كل سيرفرات القناة
    const payload = commonPayload();
    payload.id = channelId;
    const streamInfo = await encryptedPost(`${LIVE_API_BASE}/getLiveAllStreamsById`, payload);
    const live = streamInfo.live;
    if (!live) throw new Error("لم يتم العثور على معلومات القناة");

    let options = [];
    if (live.url) options.push({ url: live.url, agent: live.agent || "redirect" });
    
    if (live.backup) {
        let backups = Array.isArray(live.backup) ? live.backup : live.backup.split("-;-");
        backups.forEach(b => {
            let parts = b.split(" -- ");
            let src = parts[0].trim();
            let ag = parts[1] ? parts[1].trim() : "redirect";
            options.push({ url: src, agent: ag });
        });
    }

    if (serverIndex >= options.length) throw new Error("رقم السيرفر غير موجود");
    let selected = options[serverIndex];
    let source = selected.url;
    let resolverAgent = selected.agent;

    let resolved = { url: source, agent: "", headers: {}, swap: {} };

    // 2. حل التوجيه المزدوج (Double Redirect)
    if (["redirect", "double_redirect", "all_streams_redirect"].includes(resolverAgent)) {
        let rPayload = commonPayload();
        rPayload.id = channelId;
        rPayload.url = source;
        rPayload.agent = resolverAgent;
        
        let rData = await encryptedPost(`${REDIRECT_API_BASE}/getLiveByRedirect`, rPayload);
        let nested = rData.data?.url || {};
        if (typeof nested === 'string') {
            try { nested = JSON.parse(nested); } catch (e) { nested = { url: nested }; }
        }
        
        let nextUrl = nested.url;
        let nextAgent = nested.agent || rData.data?.agent || "redirect";

        // تخطي إضافي إذا كان السيرفر يحتاج توجيه ثاني
        if (resolverAgent === "double_redirect" && nextUrl) {
            let rPayload2 = commonPayload();
            rPayload2.id = channelId;
            rPayload2.url = nextUrl;
            rPayload2.agent = nextAgent;
            try {
                let rData2 = await encryptedPost(`${REDIRECT_API_BASE}/getLiveByRedirect`, rPayload2);
                let nested2 = rData2.data?.url || {};
                if (typeof nested2 === 'string') {
                    try { nested2 = JSON.parse(nested2); } catch (e) { nested2 = { url: nested2 }; }
                }
                if (nested2.url) {
                    nested = nested2;
                }
            } catch (e) {}
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

    // تنظيف الروابط الوهمية
    if (!resolved.url.startsWith('http')) {
        throw new Error("رابط وهمي أو مشفر، يجب التخطي");
    }

    return resolved;
}

// ==========================================
// دوال التشفير للروابط (Stateless Proxy Token)
// ==========================================
function encodeProxyToken(url, referer, userAgent, swap) {
    const data = JSON.stringify({ u: url, r: referer, a: userAgent, s: swap });
    return btoa(unescape(encodeURIComponent(data)));
}

function decodeProxyToken(token) {
    return JSON.parse(decodeURIComponent(escape(atob(token))));
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

// ==========================================
// هندسة الـ Worker الأساسية
// ==========================================
export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const workerOrigin = url.origin;

        // إعدادات CORS
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Range",
        };
        if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

        try {
            // ----------------------------------------------------
            // 1. المسار الأساسي لتشغيل القناة: /play/:channel_id
            // ----------------------------------------------------
            if (path.startsWith("/play/")) {
                const channelId = path.split("/")[2];
                let serverCount = 8; // جرب أول 8 سيرفرات كحد أقصى للتخطي
                
                for (let i = 0; i < serverCount; i++) {
                    try {
                        const info = await resolveChannel(channelId, i);
                        const targetUrl = info.url;
                        const referer = info.headers.Referer || `https://${new URL(targetUrl).hostname}/`;
                        const userAgent = info.agent || "ExoPlayer/2.18.1 (Linux; Android 13) ExoPlayerLib/2.18.1";
                        const swap = info.swap || {};

                        // تكوين توكن لا يحفظ حالة (Stateless)
                        const token = encodeProxyToken(targetUrl, referer, userAgent, swap);
                        const proxyUrl = `${workerOrigin}/proxy?t=${encodeURIComponent(token)}`;
                        
                        // إعادة التوجيه الفوري للبروكسي ليبدأ معالجة الـ M3U8/MPD
                        return Response.redirect(proxyUrl, 302);
                    } catch (err) {
                        // فشل السيرفر (رابط وهمي، HTML)، جرب الذي يليه بصمت
                        continue;
                    }
                }
                return new Response("All servers failed or blocked.", { status: 502, headers: corsHeaders });
            }

            // ----------------------------------------------------
            // 2. البروكسي لإعادة كتابة القوائم وتمرير الفيديو: /proxy
            // ----------------------------------------------------
            if (path === "/proxy") {
                const token = url.searchParams.get("t");
                if (!token) return new Response("Missing token", { status: 400 });

                const proxyData = decodeProxyToken(token);
                const targetUrl = proxyData.u;
                
                // بناء الترويسات المطلوبة لتخطي الحماية
                const fetchHeaders = new Headers();
                fetchHeaders.set("User-Agent", proxyData.a);
                fetchHeaders.set("Referer", proxyData.r);
                if (request.headers.has("Range")) fetchHeaders.set("Range", request.headers.get("Range"));

                const response = await fetch(targetUrl, {
                    method: request.method,
                    headers: fetchHeaders,
                    redirect: "follow"
                });

                const contentType = response.headers.get("content-type") || "";
                const responseUrl = response.url; // الرابط بعد الـ Redirects

                // إذا كان الملف عبارة عن قائمة تشغيل (HLS/DASH)، أعد كتابته
                if (contentType.includes("mpegurl") || targetUrl.includes(".m3u8") || contentType.includes("dash+xml") || targetUrl.includes(".mpd")) {
                    let manifestText = await response.text();
                    const baseUrl = new URL(".", responseUrl).href;

                    if (manifestText.includes("#EXTM3U")) {
                        // إعادة كتابة HLS (M3U8)
                        let rewrittenManifest = manifestText.split('\n').map(line => {
                            let trimmed = line.trim();
                            if (!trimmed) return "";
                            if (trimmed.startsWith("#")) {
                                // معالجة الروابط داخل الترويسات مثل URI="..."
                                return trimmed.replace(/URI="(.*?)"/g, (match, uri) => {
                                    let swappedUri = applySwap(uri, proxyData.s);
                                    let absoluteUrl = new URL(swappedUri, baseUrl).href;
                                    let newToken = encodeProxyToken(absoluteUrl, proxyData.r, proxyData.a, proxyData.s);
                                    return `URI="${workerOrigin}/proxy?t=${encodeURIComponent(newToken)}"`;
                                });
                            }
                            // معالجة روابط الـ Segments المباشرة
                            let swappedUri = applySwap(trimmed, proxyData.s);
                            let absoluteUrl = new URL(swappedUri, baseUrl).href;
                            let newToken = encodeProxyToken(absoluteUrl, proxyData.r, proxyData.a, proxyData.s);
                            return `${workerOrigin}/proxy?t=${encodeURIComponent(newToken)}`;
                        }).join('\n');

                        return new Response(rewrittenManifest, {
                            status: 200,
                            headers: { ...corsHeaders, "Content-Type": "application/vnd.apple.mpegurl" }
                        });
                    } 
                    else if (manifestText.includes("<MPD")) {
                        // إعادة كتابة DASH (MPD)
                        let rewrittenManifest = manifestText.replace(/(BaseURL|media|initialization|sourceURL)=["'](.*?)["']/g, (match, attr, uri) => {
                            if (!uri.startsWith("http")) uri = new URL(uri, baseUrl).href;
                            let newToken = encodeProxyToken(uri, proxyData.r, proxyData.a, proxyData.s);
                            return `${attr}="${workerOrigin}/proxy?t=${encodeURIComponent(newToken)}"`;
                        });
                        
                        return new Response(rewrittenManifest, {
                            status: 200,
                            headers: { ...corsHeaders, "Content-Type": "application/dash+xml" }
                        });
                    }
                }

                // إذا كان المحتوى مقطع فيديو (TS, M4S, MP4)، قم بتمريره مباشرة كمجرى (Stream)
                const newHeaders = new Headers(response.headers);
                newHeaders.set("Access-Control-Allow-Origin", "*");
                // حذف الترويسات التي تسبب تعارض
                newHeaders.delete("content-encoding");
                newHeaders.delete("transfer-encoding");

                return new Response(response.body, {
                    status: response.status,
                    headers: newHeaders
                });
            }

            return new Response("Drama Live Middleware Worker Running.", { status: 200 });

        } catch (error) {
            return new Response(error.message, { status: 500, headers: corsHeaders });
        }
    }
};
