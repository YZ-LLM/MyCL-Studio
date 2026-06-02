// fix/dep-graph/analyzer — dil-başına bağımlılık analiz birimi arayüzü
// (kompozisyon / Strateji deseni). Her dil (JavaScript/TypeScript, Python, ...)
// bu arayüzü uygular; grafik kurucu (index.ts) dil-bağımsız kalır → yeni dil
// eklemek = yeni analyzer, grafik kodu DEĞİŞMEZ (Open/Closed).
//
// MyCL çok dilli proje üretir/düzeltir (node, python, go, rust, java, swift,
// elixir...). Analyzer'ı olmayan dilde grafik o dosyalar için boş kalır →
// caller kaba `plan_kind`'a graceful düşer (regresyon yok).

export interface LanguageDependencyAnalyzer {
  /** İşlediği dosya uzantıları (örn. [".ts", ".tsx", ".js"]). */
  readonly extensions: readonly string[];

  /**
   * Dosya içeriğinden HAM import specifier'larını çıkar (henüz çözülmemiş —
   * örn. "./foo", "../lib/bar", "react", "a.b.c").
   */
  extractImports(filePath: string, content: string): string[];

  /**
   * Bir import specifier'ını proje içi MUTLAK dosya yoluna çöz. 3rd-party
   * paket / builtin / proje dışı / çözülemeyen → null (grafik kenarı oluşmaz).
   */
  resolveModule(
    specifier: string,
    fromFile: string,
    projectRoot: string,
  ): string | null;
}
