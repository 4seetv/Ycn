export default {
  async fetch(request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get("url");

    // إعدادات الـ CORS للسماح لموقعك بالاتصال بالـ Worker
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // الرد على طلبات الـ OPTIONS مسبقاً (Preflight)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (!targetUrl) {
      return new Response("Proxy Worker - Please provide a ?url= parameter", { status: 400, headers: corsHeaders });
    }

    // إعداد الهيدرات المطلوبة
    const fetchHeaders = new Headers(request.headers);
    fetchHeaders.set("Referer", "https://x.com/");
    
    if (targetUrl.includes(".m3u8") || targetUrl.includes(".ts") || targetUrl.includes(".js") || targetUrl.includes(".pdf")) {
      fetchHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36");
    } else {
      fetchHeaders.set("User-Agent", "okhttp/4.12.0");
      fetchHeaders.set("Accept", "application/json");
    }

    const response = await fetch(targetUrl, { headers: fetchHeaders });

    if (targetUrl.includes(".m3u8")) {
      let text = await response.text();
      let targetBase = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      
      let lines = text.split('\n');
      let rewritten = lines.map(line => {
        if (line.startsWith('#EXT-X-KEY')) {
          return line.replace(/URI="([^"]+)"/, (match, p1) => {
            let absoluteUrl = p1.startsWith('http') ? p1 : targetBase + p1;
            return `URI="${url.origin}/?url=${encodeURIComponent(absoluteUrl)}"`;
          });
        } else if (line.trim() && !line.startsWith('#')) {
          let absoluteUrl = line.startsWith('http') ? line : targetBase + line;
          return `${url.origin}/?url=${encodeURIComponent(absoluteUrl)}`;
        }
        return line;
      }).join('\n');

      return new Response(rewritten, {
        status: response.status,
        headers: { ...corsHeaders, "Content-Type": "application/vnd.apple.mpegurl" }
      });
    }

    let newResponse = new Response(response.body, response);
    
    for (const [key, value] of Object.entries(corsHeaders)) {
      newResponse.headers.set(key, value);
    }
    
    if (targetUrl.includes(".ts") || targetUrl.includes(".js") || targetUrl.includes(".pdf")) {
      newResponse.headers.set("Content-Type", "video/mp2t");
    }

    return newResponse;
  }
}
