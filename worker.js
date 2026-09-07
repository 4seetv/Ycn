export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);

    // 1. وسيط الـ API
    const apiTarget = url.searchParams.get('api_target');
    if (apiTarget) {
      try {
        const apiResponse = await fetch(apiTarget, {
          headers: { "User-Agent": "okhttp/4.12.0", "Accept": "application/json" },
          cf: { cacheTtl: 0 } // منع كلاود فلير من تخزين الرد
        });
        const newHeaders = new Headers(apiResponse.headers);
        newHeaders.set("Access-Control-Allow-Origin", "*");
        newHeaders.set("Access-Control-Expose-Headers", "t");
        return new Response(apiResponse.body, { status: apiResponse.status, headers: newHeaders });
      } catch (e) {
        return new Response("API Proxy Error", { status: 500 });
      }
    }

    // 2. وسيط البث
    const targetUrl = url.searchParams.get('url');
    const referer = url.searchParams.get('ref') || "https://x.com/";
    const userAgent = url.searchParams.get('ua') || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

    if (!targetUrl) return new Response("Missing url", { status: 400 });

    const proxyHeaders = new Headers();
    proxyHeaders.set("Referer", referer);
    proxyHeaders.set("User-Agent", userAgent);

    try {
      // إجبار كلاود فلير على جلب نسخة جديدة من السيرفر دائماً
      const response = await fetch(targetUrl, { 
        method: "GET", 
        headers: proxyHeaders, 
        redirect: "follow",
        cache: "no-store",
        cf: { cacheTtl: 0 } 
      });
      
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.delete("Content-Length"); 

      if (targetUrl.includes('.m3u8')) {
        newHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
        newHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
        newHeaders.set("Pragma", "no-cache");
        newHeaders.set("Expires", "0");
        
        let text = await response.text();
        const baseUrl = new URL(targetUrl);
        const workerBase = `${url.origin}${url.pathname}?ref=${encodeURIComponent(referer)}&ua=${encodeURIComponent(userAgent)}&url=`;

        text = text.split('\n').map(line => {
          line = line.trim();
          if (line.startsWith('#EXT-X-KEY')) {
            return line.replace(/URI="(.*?)"/, (match, p1) => {
              const absoluteUrl = new URL(p1, baseUrl).href;
              return `URI="${workerBase}${encodeURIComponent(absoluteUrl)}"`;
            });
          } else if (line && !line.startsWith('#')) {
            const absoluteUrl = new URL(line, baseUrl).href;
            let finalUrl = `${workerBase}${encodeURIComponent(absoluteUrl)}`;
            
            // [السر هنا]: إضافة طابع زمني عشوائي للقوائم الفرعية لمنع الكاش نهائياً
            if (absoluteUrl.includes('.m3u8')) {
              finalUrl += `&cb=${Date.now()}${Math.floor(Math.random() * 1000)}`;
            }
            return finalUrl;
          }
          return line;
        }).join('\n');

        return new Response(text, { status: response.status, headers: newHeaders });
      } else {
        newHeaders.set("Content-Type", "video/mp2t");
        // السماح بتخزين أجزاء الفيديو فقط لتخفيف الضغط وتقليل التقطيع
        newHeaders.set("Cache-Control", "public, max-age=3600");
        return new Response(response.body, { status: response.status, headers: newHeaders });
      }
    } catch (e) {
      return new Response(`Worker Error: ${e.message}`, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
    }
  }
}
