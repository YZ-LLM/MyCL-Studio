// Bağlam taşıyan, sıfır-bağımlılıklı ince log sarmalayıcı.
// info/warn yalnız development'ta; error her ortamda.
const isDev = process.env.NODE_ENV !== 'production';

function fmt(scope, msg, ctx) {
  return [`[${scope}] ${msg}`, ctx ? JSON.stringify(ctx) : ''].filter(Boolean).join(' ');
}

export const log = {
  info: (scope, msg, ctx) => {
    if (isDev) console.info(fmt(scope, msg, ctx));
  },
  warn: (scope, msg, ctx) => {
    if (isDev) console.warn(fmt(scope, msg, ctx));
  },
  error: (scope, msg, ctx) => {
    console.error(fmt(scope, msg, ctx));
  },
};
