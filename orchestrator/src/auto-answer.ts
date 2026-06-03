// auto-answer — "Oto-cevap" toggle (saha 3/5). Kullanıcı composer'daki "Orkestrator"
// butonunun yanındaki checkbox'ı tikleyince: ÖNERİLİ netleştirme askq'ları (ana ajanın
// suggested_answer'ı olanlar) otomatik o öneriyle yanıtlanır → daha hızlı + kaliteli iterasyon.
// Onaylar (Approve/Revise/Cancel) + önerisi olmayan sorular YİNE kullanıcıya sorulur.
//
// Modül-singleton (setSandboxPolicy deseni); frontend checkbox `set_auto_answer` komutuyla set
// eder. qa-askq backend'leri (CLI + SDK) emitAndAwait/askq noktasında bunu okur.

let _enabled = false;

export function setAutoAnswerSuggested(on: boolean): void {
  _enabled = on;
}

export function autoAnswerSuggested(): boolean {
  return _enabled;
}
