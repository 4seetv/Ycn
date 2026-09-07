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
          headers: { "User-Agent": "okhttp/4.12.0", "Accept": "application/json" }
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
    proxyHeaders.set("Connection", "keep-alive"); // إجبار السيرفر على عدم قطع الاتصال

    const range = request.headers.get("Range");
    if (range) proxyHeaders.set("Range", range);

    try {
      const response = await fetch(targetUrl, { method: "GET", headers: proxyHeaders, redirect: "follow" });
      const newHeaders = new Headers(response.headers);
      
      newHeaders.set("Access-Control-Allow-Origin", "*");
      // حذف طول المحتوى ليتم تدفق الفيديو بحرية تامة دون قيود
      newHeaders.delete("Content-Length"); 

      if (targetUrl.includes('.m3u8')) {
        newHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
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
            return `${workerBase}${encodeURIComponent(absoluteUrl)}`;
          }
          return line;
        }).join('\n');

        return new Response(text, { status: response.status, headers: newHeaders });
      } else {
        // أي جزء لا يحتوي على m3u8 نعتبره فوراً فيديو لضمان عمل كافة الامتدادات المموهة
        newHeaders.set("Content-Type", "video/mp2t");
        return new Response(response.body, { status: response.status, headers: newHeaders });
      }
    } catch (e) {
      return new Response(`Worker Error: ${e.message}`, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
    }
  }
}
