// Edge-safe sabitler — middleware (edge runtime) bunları kullanır, bu yüzden
// burada fs / next/headers / node-only kod OLMAMALI.

export const COOKIE_SESSION = 'arc_session';
export const COOKIE_LANG = 'lang';
export const COOKIE_THEME = 'theme';

export const SUPPORTED_LANGS = ['tr', 'en'];
export const DEFAULT_LANG = 'tr';
