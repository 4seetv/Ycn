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
    encryptedBase64 = encryptedBase64.trim().replace(/\s/g, ''); 

    const rawString = atob(encryptedBase64);
    const rawBytes = new Uint8Array(rawString.length);
    for (let i = 0; i < rawString.length; i++) {
        rawBytes[i] = rawString.charCodeAt(i);
    }

    const encoder = new TextEncoder();
    const keyBytes = encoder.encode(dynamicKey);
    const decryptedBytes = new Uint8Array(rawBytes.length);
    
    for (let i = 0; i < rawBytes.length; i++) {
        decryptedBytes[i] = rawBytes[i] ^ keyBytes[i % keyBytes.length];
    }

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

        if (trimmed.startsWith('#EXT-X-KEY')) {
            return trimmed.replace(/URI="(.*?)"/, (match, uri) => {
                const absUrl = new URL(uri, baseUrl).href;
                const encodedUrl = btoa(absUrl);
                return `URI="${workerOrigin}/proxy?u=${encodedUrl}&type=key"`;
            });
        } 
        else if (trimmed.startsWith('#') && trimmed.includes('URI=')) {
            return trimmed.replace(/URI="(.*?)"/, (match, uri) => {
                const absUrl = new URL(uri, baseUrl).href;
                const encodedUrl = btoa(absUrl);
                return `URI="${workerOrigin}/proxy?u=${encodedUrl}&type=m3u8"`;
            });
        } 
        else if (!trimmed.startsWith('#')) {
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
            "Content-Type": "application/json;charset=UTF-8"
        };

        if (request.method === "OPTIONS") {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            // -------------------------------------------------------------------
            // 1. جلب الأقسام (Categories)
            // -------------------------------------------------------------------
            if (path === "/categories") {
                const apiData = await fetchAndDecrypt("/categories");
                return new Response(JSON.stringify(apiData, null, 2), { status: 200, headers: corsHeaders });
            }

            // -------------------------------------------------------------------
            // 2. جلب القنوات داخل قسم معين (Channels in Category)
            // مثال: /categories/12/channels
            // -------------------------------------------------------------------
            if (path.startsWith("/categories/") && path.endsWith("/channels")) {
                const categoryId = path.split("/")[2];
                const apiData = await fetchAndDecrypt(`/categories/${categoryId}/channels`);
                return new Response(JSON.stringify(apiData, null, 2), { status: 200, headers: corsHeaders });
            }

            // -------------------------------------------------------------------
            // 3. مسار التشغيل المباشر: /play/{channel_id}
            // -------------------------------------------------------------------
            if (path.startsWith("/play/")) {
                const channelId = path.split("/")[2];
                const isRawRequested = url.searchParams.get("raw") === "1";
                const acceptHeader = request.headers.get("Accept") || "";

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
                    return new Response(html, { headers: { "Content-Type": "text/html;charset=UTF-8", "Access-Control-Allow-Origin": "*" }});
                }

                const apiData = await fetchAndDecrypt(`/channel/${channelId}`);
                if (!apiData.data || !apiData.data[0] || !apiData.data[0].url) {
                    throw new Error("Invalid Decrypted Payload: Missing URL");
                }
                const streamUrl = apiData.data[0].url;

                const m3u8Req = await fetch(streamUrl, { headers: UPSTREAM_HEADERS });
                const manifest = await m3u8Req.text();
                const rewritten = rewriteM3u8(manifest, m3u8Req.url, workerOrigin);

                return new Response(rewritten, {
                    status: 200,
                    headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/vnd.apple.mpegurl" }
                });
            }

            // -------------------------------------------------------------------
            // 4. البروكسي (معالجة المقاطع والمفاتيح الوهمية)
            // -------------------------------------------------------------------
            if (path === "/proxy") {
                const targetB64 = url.searchParams.get("u");
                const type = url.searchParams.get("type"); // m3u8 | key | ts

                if (!targetB64) return new Response("Missing URL", { status: 400 });
                const targetUrl = atob(targetB64);

                const fetchHeaders = new Headers(UPSTREAM_HEADERS);
                if (request.headers.has("Range")) {
                    fetchHeaders.set("Range", request.headers.get("Range"));
                }

                const response = await fetch(targetUrl, {
                    method: request.method,
                    headers: fetchHeaders,
                    redirect: "follow"
                });

                if (type === 'm3u8') {
                    const manifest = await response.text();
                    const rewritten = rewriteM3u8(manifest, response.url, workerOrigin);
                    return new Response(rewritten, {
                        status: 200,
                        headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/vnd.apple.mpegurl" }
                    });
                }

                const newHeaders = new Headers(response.headers);
                newHeaders.set("Access-Control-Allow-Origin", "*");
                newHeaders.delete("content-encoding");
                newHeaders.delete("transfer-encoding");

                if (type === 'ts') {
                    newHeaders.set("Content-Type", "video/mp2t");
                } else if (type === 'key') {
                    newHeaders.set("Content-Type", "application/octet-stream");
                }

                return new Response(response.body, {
                    status: response.status,
                    headers: newHeaders
                });
            }

            // مسار رئيسي كدليل استخدام
            const info = {
                "message": "YCN IPTV Middleware is Online",
                "routes": {
                    "categories": "/categories",
                    "channels_in_category": "/categories/{id}/channels",
                    "play_channel": "/play/{id}"
                }
            };
            return new Response(JSON.stringify(info, null, 2), { status: 200, headers: corsHeaders });

        } catch (error) {
            return new Response(JSON.stringify({ error: error.message }), { 
                status: 500, 
                headers: corsHeaders 
            });
        }
    }
};
