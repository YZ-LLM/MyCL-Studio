// harness-answer — ekransız koşu betiğinin (harness.mjs) bir soruyu NASIL cevaplayacağı kararı. SAF, tek fonksiyon.
//
// Betik bir insan değildir. Eski mantık `suggested_option ?? opts[0] ?? "Onayla"` idi: önerisi olmayan soruda İLK
// seçeneği körlemesine seçiyordu. Model yükseltme sorusunda ilk seçenek "Evet, geç" olduğu için betik kullanıcının
// kalıcı model ayarını değiştirdi. Kural artık şu:
//   - `protected` (yalnız kullanıcı cevaplar) işaretli soru CEVAPLANMAZ.
//   - Soru önerilen seçenek taşıyorsa o seçilir (güvenli varsayılanı soru kendisi söyler).
//   - Öneri yoksa CEVAPLANMAZ. Oto-cevap açıkken MyCL akışı ilerleten soruları zaten kendisi cevaplar; betiğe
//     ulaşan önerisiz soru, MyCL'in bilerek insana bıraktığı bir karardır (davranış değişikliği onayı, iptal,
//     kalıcı ayar). Tahmin edilmez; betik bunu görünür yazar ve koşu o soruda bekler.
//
// Dönüş: { answer: string } → bu cevap gönderilir; { answer: null, why: string } → gönderilmez.

/** @param {{ options?: unknown[], suggested_option?: unknown, protected?: unknown }} data */
export function pickHarnessAnswer(data) {
  if (data?.protected === true) {
    return { answer: null, why: "yalnız kullanıcı cevaplar (protected)" };
  }
  const suggested = data?.suggested_option;
  if (typeof suggested === "string" && suggested.trim() !== "") {
    return { answer: suggested };
  }
  return { answer: null, why: "soru önerilen seçenek taşımıyor; betik tahmin etmez" };
}
