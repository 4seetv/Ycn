export default {
  async fetch(request, env, ctx) {
    // 1. التعامل مع طلبات OPTIONS لمشغلات الويب (CORS Preflight)
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        }
      });
    }

    const url = new URL(request.url);

    // ==========================================
    // 2. الحماية: المسار السري (يمكنك تغييره لأي كلمة تريدها)
    // ==========================================
    const SECRET_PATH = '/enlil'; 

    // إذا كان الرابط لا يحتوي على المسار السري، نمنع الوصول
    if (!url.pathname.startsWith(SECRET_PATH)) {
      return new Response('Access Denied (محمي)', { status: 403 });
    }

    // ==========================================
    // 3. تجهيز الرابط الهدف الأصلي
    // ==========================================
    // استخراج اسم الملف المطلوب (مثل /bein1ar.m3u8) بعد إزالة المسار السري
    const requestedFile = url.pathname.replace(SECRET_PATH, '');
    const targetUrl = `https://tmaxapp.site/8wirwjs76erftg${requestedFile}${url.search}`;

    // ==========================================
    // 4. حقن الـ User-Agent الذي طلبته
    // ==========================================
    const modifiedHeaders = new Headers(request.headers);
    modifiedHeaders.set(
      'User-Agent', 
      'Mozilla/5.0 (Linux; Android 10; Pixel 3 XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'
    );
    modifiedHeaders.set('Referer', 'https://tmaxapp.site/');
    modifiedHeaders.set('Origin', 'https://tmaxapp.site');

    // ==========================================
    // 5. جلب البث من السيرفر الأصلي
    // ==========================================
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: modifiedHeaders,
      redirect: 'follow'
    });

    // ==========================================
    // 6. السماح بالتشغيل الخارجي (CORS)
    // ==========================================
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  },
};
