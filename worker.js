export default {
  async fetch(request, env, ctx) {
    // 1. معالجة طلبات الفحص الأمني (CORS Preflight) للمتصفح فوراً
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

    if (!targetUrl) {
      return new Response("Missing url parameter", { status: 400 });
    }

    // 2. تجهيز ترويسات الحماية الإلزامية للمصدر
    const proxyHeaders = new Headers();
    proxyHeaders.set("Referer", "https://x.com/");
    proxyHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36");
    
    // السماح بتمرير أجزاء محددة من الفيديو (مهم جداً لاستقرار المشغل)
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
      // إجبار المتصفح على قبول البث
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");

      // 3. قسر أنواع المحتوى (MIME Types) لتفادي رفض المشغل لها
      if (targetUrl.includes('.pdf') || targetUrl.includes('.js') || targetUrl.includes('.ts')) {
        newHeaders.set("Content-Type", "video/mp2t");
      } else if (targetUrl.includes('.m3u8')) {
        newHeaders.set("Content-Type", "application/vnd.apple.mpegurl");
        
        let text = await response.text();
        const baseUrl = new URL(targetUrl);
        const workerBase = url.origin + url.pathname + "?url=";

        // 4. إعادة كتابة محتوى الـ m3u8 ليمر كل شيء عبر الكلاود فلير
        text = text.split('\n').map(line => {
          line = line.trim();
          if (line.startsWith('#EXT-X-KEY')) {
            // توجيه مفتاح التشفير AES للوسيط
            return line.replace(/URI="(.*?)"/, (match, p1) => {
              const absoluteUrl = new URL(p1, baseUrl).href;
              return `URI="${workerBase}${encodeURIComponent(absoluteUrl)}"`;
            });
          } else if (line && !line.startsWith('#')) {
            // توجيه أجزاء الفيديو (Chunks) أو القوائم الفرعية للوسيط
            const absoluteUrl = new URL(line, baseUrl).href;
            return `${workerBase}${encodeURIComponent(absoluteUrl)}`;
          }
          return line;
        }).join('\n');

        return new Response(text, { status: response.status, headers: newHeaders });
      }

      // إرجاع أجزاء الفيديو أو مفاتيح التشفير مباشرة
      return new Response(response.body, { status: response.status, headers: newHeaders });
      
    } catch (e) {
      return new Response(`Worker Proxy Error: ${e.message}`, { 
        status: 500, 
        headers: { "Access-Control-Allow-Origin": "*" } 
      });
    }
  }
}
