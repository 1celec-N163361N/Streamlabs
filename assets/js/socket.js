// عميل Engine.IO v4 (Socket.IO v4) — بدون أي مكتبة خارجية
// Streamlabs يستخدم sockets.streamlabs.com على بروتوكول EIO=4
// ملاحظة: في v4 السيرفر هو اللي يرسل ping (2) والعميل يرد pong (3)

const EIO = 4;

export class StreamlabsSocket {
  constructor() {
    this.ws = null;
    this.ready = false;
    this.handlers = new Map();
    this.lastPong = 0;
  }

  on(name, fn) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name).push(fn);
    return this;
  }

  emit(name, ...args) {
    (this.handlers.get(name) || []).forEach((fn) => {
      try { fn(...args); } catch (e) { console.error(e); }
    });
  }

  connect(token, timeout = 14000) {
    return new Promise((resolve, reject) => {
      this.close();

      const url =
        `wss://sockets.streamlabs.com/socket.io/?EIO=${EIO}&transport=websocket&token=` +
        encodeURIComponent(token);

      let ws;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        return reject(new Error('المتصفح ما قدر يفتح اتصال WebSocket'));
      }

      this.ws = ws;
      let settled = false;
      let wasReady = false;

      const fail = (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = false;
        try { ws.close(); } catch (_) {}
        reject(new Error(msg));
      };

      const ok = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ready = true;
        wasReady = true;
        resolve(true);
        this.emit('ready');
      };

      const timer = setTimeout(
        () => fail('انتهت مهلة الاتصال — تأكد أن التوكن صحيح وأن الإنترنت يعمل'),
        timeout
      );

      ws.onmessage = (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : '';
        if (!data) return;

        const code = data[0];

        // حزمة الفتح — نفتح النطاق الافتراضي
        if (code === '0') {
          try { ws.send('40'); } catch (_) {}
          return;
        }

        // نبض السيرفر — نرد pong فورًا وإلا يقطع الاتصال
        if (code === '2') {
          try { ws.send('3'); } catch (_) {}
          this.lastPong = Date.now();
          return;
        }

        // تم فتح النطاق
        if (data.startsWith('40')) { ok(); return; }

        // حدث
        if (data.startsWith('42')) {
          try {
            const arr = JSON.parse(data.slice(2));
            if (arr[0] === 'event') this.emit('event', arr[1]);
          } catch (_) {}
          return;
        }

        // رفض النطاق
        if (data.startsWith('44')) {
          let msg = 'التوكن غير صالح — أعد نسخه من Streamlabs';
          try {
            const info = JSON.parse(data.slice(2));
            if (info && info.message) msg = 'رفض Streamlabs الاتصال: ' + info.message;
          } catch (_) {}
          fail(msg);
          return;
        }

        // إغلاق من السيرفر
        if (code === '1') {
          if (!this.ready) fail('رفض السيرفر الاتصال');
          else { this.ready = false; this.emit('close'); }
        }
      };

      ws.onerror = () => {
        if (!this.ready) fail('تعذّر الاتصال بـ Streamlabs — تحقق من الشبكة');
      };

      ws.onclose = () => {
        clearTimeout(timer);
        if (!settled) return fail('انقطع الاتصال قبل التأكيد');
        if (wasReady) {
          this.ready = false;
          this.emit('close');
        }
      };
    });
  }

  close() {
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.onmessage = null;
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.ready = false;
  }
}
