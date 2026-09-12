export default {
  async fetch(request, env, ctx) {
    // 1. السماح بطلبات CORS لتعمل على جميع المشغلات والمتصفحات
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

    // 2. المسار السري للحماية (تأكد من استخدامه في روابطك)
    const SECRET_PATH = '/enlil'; 

    if (!url.pathname.startsWith(SECRET_PATH)) {
      return new Response('Access Denied (محمي)', { status: 403 });
    }

    // 3. تجهيز الرابط الأصلي
    const originBase = 'https://tmaxapp.site/8wirwjs76erftg';
    const requestedFile = url.pathname.replace(SECRET_PATH, '');
    const targetUrl = `${originBase}${requestedFile}${url.search}`;

    // 4. إعداد الـ Headers المطلوبة وإزالة ضغط البيانات لضمان قراءة الملفات
    const modifiedHeaders = new Headers(request.headers);
    modifiedHeaders.set(
      'User-Agent', 
      'Mozilla/5.0 (Linux; Android 10; Pixel 3 XL) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'
    );
    modifiedHeaders.set('Referer', 'https://tmaxapp.site/');
    modifiedHeaders.set('Origin', 'https://tmaxapp.site');
    // إزالة هذا السطر يمنع السيرفر الأصلي من تشفير الرد مما يسمح لنا بتعديله
    modifiedHeaders.delete('Accept-Encoding'); 

    // 5. جلب البيانات من السيرفر
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: modifiedHeaders,
      redirect: 'follow'
    });

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    // 6. التحكم بالتخزين المؤقت (مهم جداً لمنع التقطيع)
    if (targetUrl.includes('.m3u8')) {
      // ملفات القوائم الحية يجب أن تتحدث باستمرار ولا يتم تخزينها
      responseHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    } else {
      // مقاطع الفيديو (.ts) يتم حفظها مؤقتاً لتسريع البث ومنع التحميل المتكرر
      responseHeaders.set('Cache-Control', 'public, max-age=3600');
    }

    // 7. معالجة ملفات M3U8 (الجودات) وتعديلها داخلياً
    const contentType = responseHeaders.get('content-type') || '';
    if (targetUrl.includes('.m3u8') || contentType.includes('mpegurl')) {
      let m3u8Text = await response.text();

      // تحويل الروابط المطلقة للسيرفر الأصلي لتمر عبر الوركر
      // هذا يضمن أن الانتقال بين الجودات لا يخرج من الوركر ولا يفقد الـ User-Agent
      m3u8Text = m3u8Text.replace(new RegExp(originBase, 'g'), `https://${url.host}${SECRET_PATH}`);
      
      // تحويل الروابط الجذرية إن وجدت
      m3u8Text = m3u8Text.replace(new RegExp('/8wirwjs76erftg/', 'g'), `${SECRET_PATH}/`);

      return new Response(m3u8Text, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      });
    }

    // 8. تمرير مقاطع الفيديو (.ts) بشكل مباشر وسريع (Streaming)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
  },
};
