// =======================================================================
// CONFIGURATION & CONSTANTS
// =======================================================================
const API_BASE = "https://def.ycnapi.com/api";
const STATIC_SECRET = "c!xZj+N9&G@Ev@vw";

const API_HEADERS = {
    "User-Agent": "okhttp/4.12.0",
    "Accept": "application/json"
};

const UPSTREAM_HEADERS = {
    "Referer": "https://x.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
};

// =======================================================================
// DECRYPTION ALGORITHM (BASE64 + DYNAMIC XOR)
// =======================================================================
async function fetchAndDecrypt(endpoint) {
    const url = `${API_BASE}${endpoint}`;
    const response = await fetch(url, { headers: API_HEADERS });
    
    if (!response.ok) {
        throw new Error(`API Request Failed: ${response.status}`);
    }

    const tHeader = response.headers.get("t");
    if (!tHeader) {
        throw new Error("Missing 't' header in API response for decryption.");
    }

    const dynamicKey = STATIC_SECRET + tHeader;
    let encryptedBase64 = await response.text();
    encryptedBase64 = encryptedBase64.trim().replace(/\s/g, ''); // تنظيف النص

    // 1. Base64 Decode
    const rawString = atob(encryptedBase64);
    const rawBytes = new Uint8Array(rawString.length);
    for (let i = 0; i < rawString.length; i++) {
        rawBytes[i] = rawString.charCodeAt(i);
    }

    // 2. XOR Decryption
    const encoder = new TextEncoder();
    const keyBytes = encoder.encode(dynamicKey);
    const decryptedBytes = new Uint8Array(rawBytes.length);
    
    for (let i = 0; i < rawBytes.length; i++) {
        decryptedBytes[i] = rawBytes[i] ^ keyBytes[i % keyBytes.length];
    }

    // 3. Parse JSON
    const decoder = new TextDecoder("utf-8");
    const jsonString = decoder.decode(decryptedBytes);
    return JSON.parse(jsonString);
}

// =======================================================================
// M3U8 MANIFEST REWRITER
// =======================================================================
function rewriteM3u8(manifest, baseUrl, workerOrigin) {
    const lines = manifest.split('\n');
    const rewritten = lines.map(line => {
        const trimmed = line.trim();
        if (!trimmed) return "";

        // اعتراض مفتاح التشفير (DRM / AES-128 KEY)
        if (trimmed.startsWith('#EXT-X-KEY')) {
            return trimmed.replace(/URI="(.*?)"/, (match, uri) => {
                const absUrl = new URL(uri, baseUrl).href;
                const encodedUrl = btoa(absUrl);
                return `URI="${workerOrigin}/proxy?u=${encodedUrl}&type=key"`;
            });
        } 
        // تمرير الروابط العادية (ملفات ts أو قوائم أخرى)
        else if (trimmed.startsWith('#') && trimmed.includes('URI=')) {
            return trimmed.replace(/URI="(.*?)"/, (match, uri) => {
                const absUrl = new URL(uri, baseUrl).href;
                const encodedUrl = btoa(absUrl);
                return `URI="${workerOrigin}/proxy?u=${encodedUrl}&type=m3u8"`;
            });
        } 
        else if (!trimmed.startsWith('#')) {
            // مقاطع الفيديو الوهمية (segments)
            const absUrl = new URL(trimmed, baseUrl).href;
            const encodedUrl = btoa(absUrl);
            return `${workerOrigin}/proxy?u=${encodedUrl}&type=ts`;
        }
        
        return trimmed;
    });
    
    return rewritten.join('\n');
}

// =======================================================================
// CLOUDFLARE WORKER ROUTER
// =======================================================================
export default {
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        const workerOrigin = url.origin;

        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Range, Accept",
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            // -------------------------------------------------------------------
            // 1. مسار التشغيل المباشر: /play/{channel_id}
            // -------------------------------------------------------------------
            if (path.startsWith("/play/")) {
                const channelId = path.split("/")[2];
                const isRawRequested = url.searchParams.get("raw") === "1";
                const acceptHeader = request.headers.get("Accept") || "";

                // مشغل ويب في حال فتح الرابط عبر المتصفح
                if (!isRawRequested && acceptHeader.includes("text/html")) {
                    const streamUrl = `${workerOrigin}/play/${channelId}?raw=1`;
                    const html = `<!DOCTYPE html>
                    <html lang="ar" dir="rtl"><head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1">
                    <title>Enlil Player</title>
                    <script src="https://cdn.jsdelivr.net/npm/hls.js@1"></script>
                    <style>body{margin:0;background:#000;display:flex;justify-content:center;align-items:center;height:100vh;} video{width:100%;height:100%;outline:none;}</style>
                    </head><body>
                    <video id="video" controls autoplay playsinline></video>
                    <script>
                      var video = document.getElementById('video');
                      var hlsUrl = '${streamUrl}';
                      if (Hls.isSupported()) {
                        var hls = new Hls({maxMaxBufferLength: 30});
                        hls.loadSource(hlsUrl);
                        hls.attachMedia(video);
                        hls.on(Hls.Events.MANIFEST_PARSED, function() { video.play().catch(e=>{}); });
                      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                        video.src = hlsUrl;
                        video.addEventListener('loadedmetadata', function() { video.play().catch(e=>{}); });
                      }
                    </script>
                    </body></html>`;
                    return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8", ...corsHeaders }});
                }

                // الاتصال بـ API وفك التشفير وجلب الرابط
                const apiData = await fetchAndDecrypt(`/channel/${channelId}`);
                if (!apiData.data || !apiData.data[0] || !apiData.data[0].url) {
                    throw new Error("Invalid Decrypted Payload: Missing URL");
                }
                const streamUrl = apiData.data[0].url;

                // جلب الماستر بلاي ليست وإعادة كتابتها ليقرأها المشغل مباشرة كملف M3U8 طبيعي
                const m3u8Req = await fetch(streamUrl, { headers: UPSTREAM_HEADERS });
                const manifest = await m3u8Req.text();
                const rewritten = rewriteM3u8(manifest, m3u8Req.url, workerOrigin);

                return new Response(rewritten, {
                    status: 200,
                    headers: { ...corsHeaders, "Content-Type": "application/vnd.apple.mpegurl" }
                });
            }

            // -------------------------------------------------------------------
            // 2. البروكسي (معالجة المقاطع والمفاتيح الوهمية)
            // -------------------------------------------------------------------
            if (path === "/proxy") {
                const targetB64 = url.searchParams.get("u");
                const type = url.searchParams.get("type"); // m3u8 | key | ts

                if (!targetB64) return new Response("Missing URL", { status: 400 });
                const targetUrl = atob(targetB64);

                // إجبار تمرير ترويسات الحماية (Rule 1)
                const fetchHeaders = new Headers(UPSTREAM_HEADERS);
                if (request.headers.has("Range")) {
                    fetchHeaders.set("Range", request.headers.get("Range"));
                }

                const response = await fetch(targetUrl, {
                    method: request.method,
                    headers: fetchHeaders,
                    redirect: "follow"
                });

                // معالجة القوائم الفرعية
                if (type === 'm3u8') {
                    const manifest = await response.text();
                    const rewritten = rewriteM3u8(manifest, response.url, workerOrigin);
                    return new Response(rewritten, {
                        status: 200,
                        headers: { ...corsHeaders, "Content-Type": "application/vnd.apple.mpegurl" }
                    });
                }

                const newHeaders = new Headers(response.headers);
                newHeaders.set("Access-Control-Allow-Origin", "*");
                
                // تنظيف الترويسات التي تعيق تدفق الفيديو (Rule 4)
                newHeaders.delete("content-encoding");
                newHeaders.delete("transfer-encoding");

                // تصحيح نوع الملف (MIME Type Spoofing Correction - Rule 3 & 2)
                if (type === 'ts') {
                    newHeaders.set("Content-Type", "video/mp2t");
                } else if (type === 'key') {
                    newHeaders.set("Content-Type", "application/octet-stream");
                }

                // تمرير المقطع فوراً كـ Stream دون تحميله بالكامل
                return new Response(response.body, {
                    status: response.status,
                    headers: newHeaders
                });
            }

            return new Response("YCN IPTV Middleware is Online.", { status: 200 });

        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), { 
                status: 500, 
                headers: { ...corsHeaders, "Content-Type": "application/json" }
            });
        }
    }
};
