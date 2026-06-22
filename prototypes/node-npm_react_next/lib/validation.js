// FIELD_DEFS'ten beslenen ortak doğrulama (istemci ön-kontrol + sunucu Server Action
// içinde de çağrılır). Hata anahtarı i18n'e map'lenmez; alan başına Türkçe/İngilizce
// mesaj çağıran tarafta üretilir — burada makine-okur kod + insan mesajı döner.
import { FIELD_DEFS } from '@/lib/field-defs';

// Ham (string) form değerlerini doğrular, { values, errors } döndürür.
// errors: { [fieldName]: messageKeyOrText }
export function validateProduct(raw) {
  const errors = {};
  const values = {};

  for (const def of FIELD_DEFS) {
    const rawVal = raw[def.name];
    const str = rawVal == null ? '' : String(rawVal).trim();

    if (def.required && str === '') {
      errors[def.name] = 'required';
      continue;
    }
    if (!def.required && str === '') {
      values[def.name] = def.type === 'textarea' ? '' : '';
      continue;
    }

    if (def.type === 'number') {
      const num = Number(str);
      if (Number.isNaN(num)) {
        errors[def.name] = 'invalid';
        continue;
      }
      if (def.integer && !Number.isInteger(num)) {
        errors[def.name] = 'integer';
        continue;
      }
      if (typeof def.minValue === 'number' && num < def.minValue) {
        errors[def.name] = 'min';
        continue;
      }
      values[def.name] = num;
    } else {
      if (typeof def.min === 'number' && str.length < def.min) {
        errors[def.name] = 'minLen';
        continue;
      }
      if (typeof def.max === 'number' && str.length > def.max) {
        errors[def.name] = 'maxLen';
        continue;
      }
      values[def.name] = str;
    }
  }

  return { values, errors, ok: Object.keys(errors).length === 0 };
}

// Doğrulama kodu → kullanıcı mesajı (her iki dil).
export function validationMessage(lang, def, code) {
  const labels = {
    tr: {
      required: 'Bu alan zorunlu',
      invalid: 'Geçerli bir sayı girin',
      integer: 'Tam sayı girin',
      min: `En az ${def.minValue} olmalı`,
      minLen: `En az ${def.min} karakter olmalı`,
      maxLen: `En fazla ${def.max} karakter olabilir`,
    },
    en: {
      required: 'This field is required',
      invalid: 'Enter a valid number',
      integer: 'Enter a whole number',
      min: `Must be at least ${def.minValue}`,
      minLen: `Must be at least ${def.min} characters`,
      maxLen: `Must be at most ${def.max} characters`,
    },
  };
  const table = labels[lang] || labels.tr;
  return table[code] || (lang === 'en' ? 'Invalid value' : 'Geçersiz değer');
}
