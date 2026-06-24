// İkili Soru Bankası — sınırlı/deduped/budgeted escalation kuyruğu (saf, Dilim 3a).
//
// Müfettiş paneli: mevcut escalation chat-relay'i (izlenmeyen, dedupe'siz,
// budget'sız) bankanın artan "Hayır"ları altında rubber-stamping'e sürükler.
// Çözüm: ilk-sınıf, KEY'e göre deduped, checkpoint başına batch'lenen, BÜTÇELİ
// kuyruk. Açık-pending budget'ı aşınca pipeline SESSİZ değil LOUD degrade eder
// (never-silently-stall ∧ never-needlessly-block uzlaşısı). IO-suz + test'li;
// `now` enjekte edilir (deterministik). Kalıcılaştırma Dilim 3b'de bağlanır.

export type EscalationLane = "defect" | "infra";

export interface EscalationEntry {
  /** Dedup anahtarı — genelde "<checkpoint>:<stack>:<artifact>:<check-id>". */
  key: string;
  checkpoint: string;
  question_id: string;
  /** İnsan-yüzlü soru metni. */
  text: string;
  /** FAIL → defect, INCONCLUSIVE → infra (ayrı hat). */
  lane: EscalationLane;
}

export interface EscalationItem extends EscalationEntry {
  /** Aynı-KEY kaç kez geldi (dedup sayacı). */
  count: number;
  first_seen: number;
  last_seen: number;
}

export class EscalationQueue {
  private readonly items = new Map<string, EscalationItem>();

  /** budget: açık-pending eşiği; aşılınca overBudget=true (LOUD degrade sinyali). */
  constructor(private readonly budget: number) {}

  /** Bir "Hayır"ı ekle. Aynı KEY varsa count++ (yeni item açmaz). */
  add(entry: EscalationEntry, now: number): void {
    const existing = this.items.get(entry.key);
    if (existing) {
      existing.count++;
      existing.last_seen = now;
      return;
    }
    this.items.set(entry.key, { ...entry, count: 1, first_seen: now, last_seen: now });
  }

  /** İnsan çözünce (verdict verilince) kuyruktan düş. */
  resolve(key: string): boolean {
    return this.items.delete(key);
  }

  get size(): number {
    return this.items.size;
  }

  /** Açık-pending budget'ı aştı mı → pipeline LOUD degrade etmeli. */
  get overBudget(): boolean {
    return this.items.size > this.budget;
  }

  list(): EscalationItem[] {
    return [...this.items.values()];
  }

  /** Checkpoint başına grupla (batch'li insan-incelemesi için). */
  byCheckpoint(): Map<string, EscalationItem[]> {
    const out = new Map<string, EscalationItem[]>();
    for (const item of this.items.values()) {
      const arr = out.get(item.checkpoint) ?? [];
      arr.push(item);
      out.set(item.checkpoint, arr);
    }
    return out;
  }
}
