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

    // 1. وسيط الـ API (لحل مشكلة الـ IP Binding)
    const apiTarget = url.searchParams.get('api_target');
    if (apiTarget) {
      try {
        const apiResponse = await fetch(apiTarget, {
          headers: { "User-Agent": "okhttp/4.12.0", "Accept": "application/json" },
          cache: "no-store" // منع كاش الـ API
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

    if (!targetUrl) return new Response("Missing url parameter", { status: 400 });

    const proxyHeaders = new Headers();
    proxyHeaders.set("Referer", referer);
    proxyHeaders.set("User-Agent", userAgent);

    try {
      // جلب البيانات من السيرفر الأصلي مع أمر صريح بعدم التخزين المؤقت
      const response = await fetch(targetUrl, { 
        method: "GET", 
        headers: proxyHeaders, 
        redirect: "follow",
        cache: "no-store" 
      });
      
      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.delete("Content-Length"); 

      if (targetUrl.includes('.m3u8')) {
        newHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
        
        // إجبار متصفح المستخدم على عدم حفظ الكاش ليعمل البث المباشر
        newHeaders.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        
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
            // إرجاع الرابط كما هو بالضبط دون إضافة أي أرقام عشوائية حتى لا نفسد التوكن
            return `${workerBase}${encodeURIComponent(absoluteUrl)}`;
          }
          return line;
        }).join('\n');

        return new Response(text, { status: response.status, headers: newHeaders });
      } else {
        newHeaders.set("Content-Type", "video/mp2t");
        return new Response(response.body, { status: response.status, headers: newHeaders });
      }
    } catch (e) {
      return new Response(`Worker Proxy Error: ${e.message}`, { status: 500 });
    }
  }
}
