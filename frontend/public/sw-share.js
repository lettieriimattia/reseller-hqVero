// sw-share.js — gestore del Web Share Target.
// Quando l'utente condivide una foto verso "HQ" da un'altra app, il sistema invia
// un POST multipart a /share-target. Qui prendiamo la foto, la salviamo in una
// cache e reindirizziamo l'app a /?share=1, dove la pagina la legge e lancia lo scan.
self.addEventListener('fetch', (event) => {
  try {
    const url = new URL(event.request.url);
    if (event.request.method === 'POST' && url.pathname === '/share-target') {
      event.respondWith((async () => {
        try {
          const formData = await event.request.formData();
          const file = formData.get('image');
          if (file && file.size > 0) {
            const cache = await caches.open('hq-shared');
            await cache.put(
              '/__shared_image',
              new Response(file, { headers: { 'Content-Type': file.type || 'image/jpeg' } })
            );
          }
        } catch (e) {
          // se qualcosa va storto apriamo comunque l'app
        }
        return Response.redirect('/?share=1', 303);
      })());
    }
  } catch (e) {
    // ignora: lascia gestire agli altri handler
  }
});
