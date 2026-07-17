// FIELD_DEFS — ürün alanlarının TEK kaynağı. ProductForm, ProductTable ve doğrulama
// hepsi buradan beslenir (Open/Closed: şema değişimi tek noktada).
export const FIELD_DEFS = [
  { name: 'code', labelKey: 'field.code', type: 'text', required: true, min: 3, max: 50, inTable: true },
  { name: 'name', labelKey: 'field.name', type: 'text', required: true, min: 1, max: 200, inTable: true },
  { name: 'category', labelKey: 'field.category', type: 'text', required: true, min: 1, max: 100, inTable: true },
  { name: 'price', labelKey: 'field.price', type: 'number', required: true, minValue: 0, step: '0.01', inTable: true },
  { name: 'stock', labelKey: 'field.stock', type: 'number', required: true, minValue: 0, integer: true, step: '1', inTable: true },
  { name: 'description', labelKey: 'field.description', type: 'textarea', required: false, max: 2000, inTable: false },
];

export const TABLE_FIELDS = FIELD_DEFS.filter((f) => f.inTable);
