// Dil sistemi (i18n) — TR + EN mesaj katalogları. Tüm kullanıcıya görünen metinler
// buradan geçer; kod tanımlayıcıları / rotalar / loglar İngilizce kalır.
import { SUPPORTED_LANGS, DEFAULT_LANG } from '@/lib/auth-constants';

export const messages = {
  tr: {
    'app.name': 'Arçelik Back-Office',
    'app.tagline': 'Yönetim Paneli',

    'common.loading': 'Yükleniyor…',
    'common.retry': 'Tekrar dene',
    'common.cancel': 'Vazgeç',
    'common.save': 'Kaydet',
    'common.create': 'Oluştur',
    'common.delete': 'Sil',
    'common.close': 'Kapat',
    'common.back': 'Geri',
    'common.search': 'Ara',
    'common.actions': 'İşlemler',
    'common.loadFailed': 'İçerik yüklenemedi. Tekrar dene.',
    'common.actionFailed': 'İşlem tamamlanamadı, tekrar deneyin.',
    'common.serverError': 'Sunucu hatası — tekrar deneyin.',
    'common.required': 'zorunlu',
    'common.skipToContent': 'İçeriğe geç',

    'nav.products': 'Ürünler',
    'nav.errorCodes': 'Hata Kodları',
    'nav.guide': 'Kılavuz',
    'nav.settings': 'Ayarlar',
    'nav.logout': 'Çıkış',
    'nav.menu': 'Menü',
    'nav.primary': 'Ana gezinme',

    'role.admin': 'Yönetici',
    'role.dealer': 'Bayi',
    'role.service_technician': 'Servis Teknisyeni',

    'login.title': 'Giriş Yap',
    'login.subtitle': 'Hesabınızla panele giriş yapın',
    'login.username': 'Kullanıcı adı',
    'login.password': 'Şifre',
    'login.submit': 'Giriş Yap',
    'login.submitting': 'Giriş yapılıyor…',
    'login.invalid': 'Kullanıcı adı veya şifre hatalı',
    'login.failed': 'Giriş yapılamadı, tekrar deneyin.',
    'login.devHint': 'Geliştirme girişi',
    'login.langLabel': 'Dil',

    'products.title': 'Ürünler',
    'products.new': 'Yeni Ürün',
    'products.empty': 'Henüz ürün bulunmuyor',
    'products.loadError': 'Ürünler yüklenemedi. Tekrar dene.',
    'products.createTitle': 'Yeni Ürün',
    'products.editTitle': 'Ürünü Düzenle',
    'products.edit': 'Düzenle',
    'products.delete': 'Sil',
    'products.deleteTitle': 'Ürünü sil',
    'products.deleteConfirm': 'Bu ürünü silmek istediğinizden emin misiniz?',
    'products.created': 'Ürün oluşturuldu.',
    'products.updated': 'Ürün güncellendi.',
    'products.deleted': 'Ürün silindi.',
    'products.noPermission': 'Bu işlem için yetkiniz yok',
    'products.conflictCode': 'Bu ürün kodu zaten kullanımda',
    'products.backToList': 'Ürün listesine dön',

    'field.code': 'Ürün Kodu',
    'field.name': 'Ad',
    'field.category': 'Kategori',
    'field.price': 'Fiyat (₺)',
    'field.stock': 'Stok',
    'field.description': 'Açıklama',

    'errors.title': 'Hata Kodları',
    'errors.time': 'Zaman',
    'errors.code': 'Kod',
    'errors.location': 'Konum',
    'errors.description': 'Açıklama',
    'errors.status': 'Durum',
    'errors.resolved': '✓ çözüldü',
    'errors.open': '⚠ açık',
    'errors.empty': 'Henüz hata kaydı yok.',
    'errors.loadError': 'Hata kayıtları yüklenemedi',
    'errors.searchPlaceholder': 'Açıklama veya konumda ara…',

    'settings.title': 'Ayarlar',
    'settings.language': 'Dil',
    'settings.languageDesc': 'Panel dilini seçin. Tercihiniz kaydedilir.',
    'settings.theme': 'Tema',
    'settings.themeDesc': 'Açık veya koyu temayı seçin.',
    'settings.turkish': 'Türkçe',
    'settings.english': 'English',
    'settings.themeLight': 'Açık',
    'settings.themeDark': 'Koyu',

    'theme.toggle': 'Temayı değiştir',
    'theme.light': 'Açık tema',
    'theme.dark': 'Koyu tema',

    'guide.title': 'Kılavuz',
    'guide.intro': 'Uygulamanın her sayfasını nasıl kullanacağınızı buradan öğrenebilirsiniz.',
    'guide.empty': 'Kılavuz içeriği henüz oluşturulmadı.',
    'guide.lastUpdated': 'Son güncelleme',
    'guide.openPage': 'Bu sayfayı aç',
    'guide.missingImage': 'Ekran görüntüsü henüz hazır değil.',
    'guide.openInGuide': 'Kılavuzda aç',

    'help.open': 'Yardım',
    'help.tabTr': 'Türkçe',
    'help.tabEn': 'English',
    'help.none': 'Bu sayfa için yardım içeriği bulunmuyor.',

    'verify.title': 'Doğrulama',
    'verify.desc': 'Kayıtlı e-posta adresinize gönderilen 8 haneli kodu girin.',
    'verify.codeLabel': 'Doğrulama kodu',
    'verify.submit': 'Doğrula',
    'verify.resend': 'Yeniden gönder',
    'verify.expiresIn': 'Kalan süre',
    'verify.expired': 'Kod süresi doldu. Lütfen yeniden gönderin.',
    'verify.invalid': 'Kod hatalı veya geçersiz.',
    'verify.resent': 'Yeni kod gönderildi.',
    'verify.seconds': 'sn',

    'boundary.title': 'Bir hata oluştu',
    'boundary.message': 'Bir hata oluştu. Sayfayı yenileyin.',
    'boundary.refresh': 'Sayfayı yenile',

    'notfound.title': 'Sayfa bulunamadı',
    'notfound.message': 'Aradığınız sayfa mevcut değil.',
    'notfound.home': 'Ana sayfaya dön',
  },
  en: {
    'app.name': 'Arçelik Back-Office',
    'app.tagline': 'Management Panel',

    'common.loading': 'Loading…',
    'common.retry': 'Try again',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.create': 'Create',
    'common.delete': 'Delete',
    'common.close': 'Close',
    'common.back': 'Back',
    'common.search': 'Search',
    'common.actions': 'Actions',
    'common.loadFailed': 'Content failed to load. Try again.',
    'common.actionFailed': 'The action could not be completed, please try again.',
    'common.serverError': 'Server error — please try again.',
    'common.required': 'required',
    'common.skipToContent': 'Skip to content',

    'nav.products': 'Products',
    'nav.errorCodes': 'Error Codes',
    'nav.guide': 'Guide',
    'nav.settings': 'Settings',
    'nav.logout': 'Log out',
    'nav.menu': 'Menu',
    'nav.primary': 'Primary navigation',

    'role.admin': 'Admin',
    'role.dealer': 'Dealer',
    'role.service_technician': 'Service Technician',

    'login.title': 'Sign In',
    'login.subtitle': 'Sign in to the panel with your account',
    'login.username': 'Username',
    'login.password': 'Password',
    'login.submit': 'Sign In',
    'login.submitting': 'Signing in…',
    'login.invalid': 'Invalid username or password',
    'login.failed': 'Sign-in failed, please try again.',
    'login.devHint': 'Development login',
    'login.langLabel': 'Language',

    'products.title': 'Products',
    'products.new': 'New Product',
    'products.empty': 'No products yet',
    'products.loadError': 'Products failed to load. Try again.',
    'products.createTitle': 'New Product',
    'products.editTitle': 'Edit Product',
    'products.edit': 'Edit',
    'products.delete': 'Delete',
    'products.deleteTitle': 'Delete product',
    'products.deleteConfirm': 'Are you sure you want to delete this product?',
    'products.created': 'Product created.',
    'products.updated': 'Product updated.',
    'products.deleted': 'Product deleted.',
    'products.noPermission': 'You are not authorized for this action',
    'products.conflictCode': 'This product code is already in use',
    'products.backToList': 'Back to product list',

    'field.code': 'Product Code',
    'field.name': 'Name',
    'field.category': 'Category',
    'field.price': 'Price (₺)',
    'field.stock': 'Stock',
    'field.description': 'Description',

    'errors.title': 'Error Codes',
    'errors.time': 'Time',
    'errors.code': 'Code',
    'errors.location': 'Location',
    'errors.description': 'Description',
    'errors.status': 'Status',
    'errors.resolved': '✓ resolved',
    'errors.open': '⚠ open',
    'errors.empty': 'No error records yet.',
    'errors.loadError': 'Error records failed to load',
    'errors.searchPlaceholder': 'Search description or location…',

    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.languageDesc': 'Choose the panel language. Your preference is saved.',
    'settings.theme': 'Theme',
    'settings.themeDesc': 'Choose a light or dark theme.',
    'settings.turkish': 'Türkçe',
    'settings.english': 'English',
    'settings.themeLight': 'Light',
    'settings.themeDark': 'Dark',

    'theme.toggle': 'Toggle theme',
    'theme.light': 'Light theme',
    'theme.dark': 'Dark theme',

    'guide.title': 'Guide',
    'guide.intro': 'Learn how to use every page of the application here.',
    'guide.empty': 'Guide content has not been generated yet.',
    'guide.lastUpdated': 'Last updated',
    'guide.openPage': 'Open this page',
    'guide.missingImage': 'Screenshot is not ready yet.',
    'guide.openInGuide': 'Open in guide',

    'help.open': 'Help',
    'help.tabTr': 'Türkçe',
    'help.tabEn': 'English',
    'help.none': 'No help content for this page.',

    'verify.title': 'Verification',
    'verify.desc': 'Enter the 8-digit code sent to your registered email address.',
    'verify.codeLabel': 'Verification code',
    'verify.submit': 'Verify',
    'verify.resend': 'Resend',
    'verify.expiresIn': 'Time left',
    'verify.expired': 'The code has expired. Please resend.',
    'verify.invalid': 'The code is incorrect or invalid.',
    'verify.resent': 'A new code has been sent.',
    'verify.seconds': 's',

    'boundary.title': 'Something went wrong',
    'boundary.message': 'Something went wrong. Please refresh the page.',
    'boundary.refresh': 'Refresh page',

    'notfound.title': 'Page not found',
    'notfound.message': 'The page you are looking for does not exist.',
    'notfound.home': 'Back to home',
  },
};

export function isSupportedLang(lang) {
  return SUPPORTED_LANGS.includes(lang);
}

// Çözümleme sırası: ?lang > cookie > Accept-Language > varsayılan (tr).
export function resolveLang({ param, cookie, acceptLanguage } = {}) {
  if (isSupportedLang(param)) return param;
  if (isSupportedLang(cookie)) return cookie;
  if (typeof acceptLanguage === 'string' && /(^|,|\s)en\b/i.test(acceptLanguage)) return 'en';
  return DEFAULT_LANG;
}

// Server tarafı çeviri: t(lang, key) — eksik anahtarda anahtarı döndürür.
export function t(lang, key) {
  const cat = messages[lang] || messages[DEFAULT_LANG];
  return cat[key] ?? messages[DEFAULT_LANG][key] ?? key;
}

export function getMessages(lang) {
  return messages[lang] || messages[DEFAULT_LANG];
}
