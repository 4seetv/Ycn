export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Range, User-Agent, Accept",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    // استقبال الـ Referer والـ User-Agent من الفلاسك، أو استخدام قيم افتراضية
    const referer = url.searchParams.get('ref') || "https://x.com/";
    const userAgent = url.searchParams.get('ua') || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

    if (!targetUrl) {
      return new Response("Missing url parameter", { status: 400 });
    }

    const proxyHeaders = new Headers();
    proxyHeaders.set("Referer", referer);
    proxyHeaders.set("User-Agent", userAgent);
    
    const range = request.headers.get("Range");
    if (range) {
      proxyHeaders.set("Range", range);
    }

    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        headers: proxyHeaders,
        redirect: "follow"
      });

      const newHeaders = new Headers(response.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");

      if (targetUrl.includes('.pdf') || targetUrl.includes('.js') || targetUrl.includes('.ts')) {
        newHeaders.set("Content-Type", "video/mp2t");
      } else if (targetUrl.includes('.m3u8')) {
        newHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
        
        let text = await response.text();
        const baseUrl = new URL(targetUrl);
        
        // بناء رابط الوسيط الجديد ليحمل نفس الـ Referer والـ User-Agent للأجزاء القادمة
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
      }

      return new Response(response.body, { status: response.status, headers: newHeaders });
      
    } catch (e) {
      return new Response(`Worker Proxy Error: ${e.message}`, { status: 500, headers: { "Access-Control-Allow-Origin": "*" } });
    }
  }
}
