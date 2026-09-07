
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
      return new Response("Missing url parameter", { status: 400 });
    }

    // تجهيز الترويسات المطلوبة لتخطي الحماية
    const proxyHeaders = new Headers();
    proxyHeaders.set("Referer", "https://x.com/");
    proxyHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36");
    proxyHeaders.set("Connection", "keep-alive");

    try {
      const response = await fetch(targetUrl, {
        headers: proxyHeaders,
        redirect: "follow"
      });

      const newHeaders = new Headers(response.headers);
      // السماح بتشغيل البث في أي مشغل ويب (CORS)
      newHeaders.set("Access-Control-Allow-Origin", "*");

      // قسر نوع المحتوى للأجزاء المموهة لتصبح فيديو
      if (targetUrl.includes('.pdf') || targetUrl.includes('.js')) {
        newHeaders.set("Content-Type", "video/mp2t");
      }

      // إذا كان الملف m3u8، يجب إعادة كتابة الروابط داخله لتعود إلى هذا الـ Worker
      if (targetUrl.includes('.m3u8')) {
        let text = await response.text();
        const baseUrl = new URL(targetUrl);
        const workerBase = url.origin + url.pathname + "?url=";

        // تحليل وتعديل أسطر قائمة التشغيل
        text = text.split('\n').map(line => {
          // تعديل روابط مفاتيح التشفير AES-128
          if (line.startsWith('#EXT-X-KEY')) {
            return line.replace(/URI="(.*?)"/, (match, p1) => {
              const absoluteUrl = new URL(p1, baseUrl).href;
              return `URI="${workerBase}${encodeURIComponent(absoluteUrl)}"`;
            });
          } 
          // تعديل روابط أجزاء الفيديو (TS Chunks)
          else if (!line.startsWith('#') && line.trim() !== '') {
            const absoluteUrl = new URL(line.trim(), baseUrl).href;
            return `${workerBase}${encodeURIComponent(absoluteUrl)}`;
          }
          return line;
        }).join('\n');

        return new Response(text, { status: response.status, headers: newHeaders });
      }

      // إذا كان جزء فيديو أو مفتاح تشفير، نمرره كما هو
      return new Response(response.body, { status: response.status, headers: newHeaders });
      
    } catch (e) {
      return new Response(e.message, { status: 500 });
    }
  }
}
