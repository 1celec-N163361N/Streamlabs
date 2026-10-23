// عميل Engine.IO v3 (Socket.IO 2.x) — بدون أي مكتبة خارجية
// يستخدمه Streamlabs على wss://sockets.streamlabs.com

export class StreamlabsSocket {
  constructor() {
    this.ws = null;
    this.ready = false;
    this.pingTimer = null;
    this.handlers = new Map();
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
        'wss://sockets.streamlabs.com/socket.io/?EIO=3&transport=websocket&token=' +
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

      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(this.pingTimer);
        this.pingTimer = null;
      };

      const fail = (msg) => {
        if (settled) return;
        settled = true;
        cleanup();
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

      ws.onopen = () => {};

      ws.onmessage = (ev) => {
        const data = typeof ev.data === 'string' ? ev.data : '';
        if (!data) return;

        const code = data[0];

        if (code === '0') {
          // حزمة الفتح — نبدأ النطاق ونشغّل نبض الاتصال
          let interval = 25000;
          try { interval = JSON.parse(data.slice(1)).pingInterval || 25000; } catch (_) {}
          try { ws.send('40'); } catch (_) {}
          this.pingTimer = setInterval(() => {
            try { ws.send('2'); } catch (_) {}
          }, interval);
          return;
        }

        if (code === '2') { try { ws.send('3'); } catch (_) {} return; }
        if (data.startsWith('40')) { ok(); return; }
        if (data.startsWith('42')) {
          try {
            const arr = JSON.parse(data.slice(2));
            if (arr[0] === 'event') this.emit('event', arr[1]);
          } catch (_) {}
          return;
        }
        if (data.startsWith('44')) { fail('التوكن غير صالح — أعد نسخه من Streamlabs'); return; }
        if (code === '1') {
          if (!this.ready) fail('رفض السيرفر الاتصال');
          else { this.ready = false; this.emit('close'); }
        }
      };

      ws.onerror = () => {
        if (!this.ready) fail('تعذّر الاتصال بـ Streamlabs — تحقق من الشبكة');
      };

      ws.onclose = () => {
        cleanup();
        if (!settled) return fail('انقطع الاتصال قبل التأكيد');
        if (wasReady) {
          this.ready = false;
          this.emit('close');
        }
      };
    });
  }

  close() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.ws) {
      try {
        this.ws.onclose = null;
        this.ws.onerror = null;
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.ready = false;
  }
}
