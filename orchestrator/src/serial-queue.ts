// serial-queue — PARALEL-OLMAYAN işleri (▶ Çalıştır/build/test/lint = command_direct) çalışan iş
// (faz/orkestratör) bitince SIRAYLA işleyen FIFO kuyruk.
//
// Ümit 2026-06-12: "kuyruk çok iyi fikir. paralel çalışabilecek işleri kaynak varsa başlatır, değilse
// kuyruğa atar." Eskiden busy iken command_direct "komut bekletildi" deyip DÜŞÜRÜLÜYORDU (kaybolurdu).
// Paralel-GÜVENLİ işler (quality audit, DAST, read-only sorgular) zaten faz çalışırken serbest koşar —
// onlar bu kuyruğa hiç girmez. Buraya yalnız "tek başına çalışmalı" (shared pipeline'a dokunan) işler girer.
//
// IO-suz + test-edilebilir: dış meşguliyet bir callback ile sorulur (controller/handling/pipeline-derinliği),
// kuyruğun kendi çalışma kilidi içeride. JS tek-thread → busy() kontrolü ile shift()+running ataması
// arasında `await` YOK → interleave imkânsız (drain iki kez çağrılsa bile ikincisi running=true'da no-op).

export interface SerialQueueHooks<T> {
  /** Dış meşguliyet: bir faz controller'ı / orkestratör turu / pipeline koşuyor mu. */
  isExternallyBusy: () => boolean;
  /** İşi gerçekten çalıştır (tamamlanana kadar await edilir). */
  exec: (item: T) => Promise<void>;
  /** İş kuyruğa alındığında (görünür bilgilendirme). position = 1-tabanlı sıra. */
  onEnqueue?: (item: T, position: number) => void;
  /** Kuyruktan bir iş çalıştırılmaya başlandığında. remaining = kalan kuyruk uzunluğu. */
  onResume?: (item: T, remaining: number) => void;
}

export class SerialWorkQueue<T> {
  private items: T[] = [];
  private running = false;

  constructor(private readonly hooks: SerialQueueHooks<T>) {}

  get size(): number {
    return this.items.length;
  }
  get isRunning(): boolean {
    return this.running;
  }

  /** Kuyruk kendi işini çalıştırıyor VEYA dışarıda bir iş koşuyor → yeni iş hemen başlatılamaz. */
  private busy(): boolean {
    return this.running || this.hooks.isExternallyBusy();
  }

  /**
   * İşi gönder. Meşgulse kuyruğa alınır (false döner); boşsa hemen çalıştırılır + tamamlanana
   * kadar await edilir (true döner). Çağıran await etse de etmese de doğru çalışır.
   */
  async submit(item: T): Promise<boolean> {
    if (this.busy()) {
      this.items.push(item);
      this.hooks.onEnqueue?.(item, this.items.length);
      return false;
    }
    await this.runExclusive(item);
    return true;
  }

  /**
   * Sistem boşa çıkınca (faz/orkestratör/pipeline bitince) çağrılır — meşgul değilse kuyruktan
   * bir iş alıp çalıştırır. Meşgulse no-op (güvenli; istediğin kadar çağır). İş bitince kendini
   * zincirler (runExclusive finally → drain) → kuyruk sırayla boşalır.
   */
  async drain(): Promise<void> {
    if (this.busy()) return;
    if (this.items.length === 0) return;
    const next = this.items.shift() as T;
    this.hooks.onResume?.(next, this.items.length);
    await this.runExclusive(next);
  }

  /** Kuyruğu boşalt (örn. proje değişti → bekleyen komutlar bayat). Çalışan işi durdurmaz. */
  clear(): void {
    this.items = [];
  }

  private async runExclusive(item: T): Promise<void> {
    this.running = true;
    try {
      await this.hooks.exec(item);
    } finally {
      this.running = false;
      // Zincir: bu iş bitince sıradakini al (dış meşgul değilse drain no-op'tur).
      void this.drain();
    }
  }
}
