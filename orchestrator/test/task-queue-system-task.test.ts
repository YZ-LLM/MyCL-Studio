// system-task — sistem kaynaklı işlerde tekrar önleme + kanıtlı metin (SAF).
//
// Canlı cave kanıtı (2026-07-30): aynı iş defalarca açılmıştı — "Faz 8 hatası (çözülmeden ertelendi): —"
// 4 kez, "Faz 16 hatası" 3 kez, aynı Full Test bölümleri ve aynı semgrep etiketleri her turda yeniden.
// Kullanıcı 37 iş görüyordu ama çoğu aynı üç sorunun kopyasıydı.

import { describe, expect, it } from "vitest";
import {
  normalizeSubject,
  systemTaskKey,
  decideSystemTask,
  buildDeferredErrorTaskText,
} from "../src/task-queue/system-task.js";
import type { TaskQueueItem } from "../src/task-queue/types.js";

const MAX = 3;
const task = (p: Partial<TaskQueueItem> & { id: string }): TaskQueueItem => ({
  ts: 1,
  text: "iş",
  ...p,
});

describe("normalizeSubject / systemTaskKey", () => {
  it("büyük-küçük harf, fazla boşluk ve rakam farkı anahtarı DEĞİŞTİRMEZ", () => {
    expect(normalizeSubject("  Semgrep   OWASP  Top-10 ")).toBe(normalizeSubject("semgrep owasp top-10"));
    // "14 bulgu" ile "22 bulgu" aynı bulgu sınıfı → aynı anahtar (sayı maskeleniyor).
    expect(normalizeSubject("14 Code Findings")).toBe(normalizeSubject("22 Code Findings"));
  });

  it("anahtar kaynak+tür+konudan üretilir; METİN şablonu değişse de kaymaz", () => {
    const a = systemTaskKey({ source: "maintenance", kind: "maintenance-sast", subject: "owasp-top-ten" });
    const b = systemTaskKey({ source: "maintenance", kind: "maintenance-sast", subject: "OWASP-TOP-TEN" });
    expect(a).toBe(b);
    // Farklı tür / farklı kaynak → farklı anahtar (yanlış birleştirme yok).
    expect(a).not.toBe(systemTaskKey({ source: "security", kind: "maintenance-sast", subject: "owasp-top-ten" }));
    expect(a).not.toBe(systemTaskKey({ source: "maintenance", kind: "security-class", subject: "owasp-top-ten" }));
  });

  it("çok uzun konu ilk 12 kelimeye indirilir (anahtar şişmez)", () => {
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
    expect(normalizeSubject(long).split(" ")).toHaveLength(12);
  });
});

describe("decideSystemTask", () => {
  const key = "maintenance:maintenance-sast:semgrep owasp";
  const base = { key, text: "SAST bulgularını gider", maxRetries: MAX };

  it("kuyrukta eşi yok → yeni iş açılır", () => {
    expect(decideSystemTask({ ...base, existing: [] })).toEqual({ action: "create", key });
  });

  it("AÇIK iş (pending) → yeni iş AÇILMAZ, mevcut tazelenir", () => {
    const d = decideSystemTask({ ...base, existing: [task({ id: "t1", dedup_key: key, status: "pending" })] });
    expect(d).toEqual({ action: "refresh", key, taskId: "t1", revive: false });
  });

  it("koşan iş (running) → tazelenir, canlandırma yok", () => {
    const d = decideSystemTask({
      ...base,
      existing: [task({ id: "t2", dedup_key: key, status: "running", attempts: 9 })],
    });
    expect(d).toEqual({ action: "refresh", key, taskId: "t2", revive: false });
  });

  it("deneme hakkı DOLMUŞ pending iş → tazelenir + CANLANDIRILIR (bulgu hâlâ gerçek)", () => {
    const d = decideSystemTask({
      ...base,
      existing: [task({ id: "t3", dedup_key: key, status: "pending", attempts: MAX })],
    });
    expect(d).toEqual({ action: "refresh", key, taskId: "t3", revive: true });
  });

  it("BİTMİŞ iş → varsayılanda YENİ iş açılır (aynı bulgu tekrar çıktıysa bu regresyondur, yutulmaz)", () => {
    const d = decideSystemTask({ ...base, existing: [task({ id: "t4", dedup_key: key, status: "done" })] });
    expect(d).toEqual({ action: "create", key });
  });

  it("includeDone (verify-gap davranışı) → bitmiş iş de tekrar sayılır, yeni iş açılmaz", () => {
    const d = decideSystemTask({
      ...base,
      includeDone: true,
      existing: [task({ id: "t5", dedup_key: key, status: "done" })],
    });
    expect(d).toEqual({ action: "skip", key, taskId: "t5", why: "done" });
  });

  it("kullanıcının İPTAL ettiği iş → sessizce diriltilmez", () => {
    const d = decideSystemTask({ ...base, existing: [task({ id: "t6", dedup_key: key, status: "dropped" })] });
    expect(d).toEqual({ action: "skip", key, taskId: "t6", why: "cancelled" });
  });

  it("açık iş varken hem bitmiş hem açık kayıt varsa AÇIK olan tazelenir", () => {
    const d = decideSystemTask({
      ...base,
      existing: [
        task({ id: "old", dedup_key: key, status: "done" }),
        task({ id: "new", dedup_key: key, status: "pending" }),
      ],
    });
    expect(d).toEqual({ action: "refresh", key, taskId: "new", revive: false });
  });

  it("ANAHTARSIZ eski kayıtlar için metin benzerliği yedeği çalışır", () => {
    const existing = [task({ id: "legacy", text: "SAST bulgularını gider hemen", status: "pending" })];
    expect(decideSystemTask({ ...base, existing }).action).toBe("refresh");
    // Alakasız metin → yeni iş (yanlış birleştirme yok).
    const other = [task({ id: "x", text: "Arayüzü karanlık moda çevir", status: "pending" })];
    expect(decideSystemTask({ ...base, existing: other }).action).toBe("create");
  });

  it("farklı anahtarlı iş tekrar sayılmaz (anahtar varsa metne bakılmaz)", () => {
    const existing = [task({ id: "z", dedup_key: "security:security-class:baska", text: base.text, status: "pending" })];
    expect(decideSystemTask({ ...base, existing }).action).toBe("create");
  });
});

describe("buildDeferredErrorTaskText (kanıtsız '—' işinin yerine)", () => {
  it("analiz yapılamadığında bile faz + gerçek hata + kanıt işaretçisi + yapılacak taşır", () => {
    const t = buildDeferredErrorTaskText({
      phase: 8,
      failReason: "npm test exit 1: AC2 the DB password halves are not equal",
      auditEvent: "error-analysis-no-provider",
      auditTs: 1785000000000,
    });
    expect(t).not.toContain(": —"); // eski kanıtsız yer tutucu ("...ertelendi): —") ARTIK YOK
    expect(t).toContain("Faz 8");
    expect(t).toContain("AC2 the DB password halves");
    expect(t).toContain("error-analysis-no-provider");
    expect(t.toLowerCase()).toContain("yapılacak");
  });

  it("analiz çalıştıysa önerilen yönü başa yazar", () => {
    const t = buildDeferredErrorTaskText({ phase: 13, solutionTr: "helmet middleware ekle" });
    expect(t).toContain("helmet middleware ekle");
    expect(t).not.toContain("YAPILAMADI");
  });

  it("hata metni yoksa da kullanılabilir bir iş üretir (boş '—' değil)", () => {
    const t = buildDeferredErrorTaskText({ phase: 16 });
    expect(t).toContain("Faz 16");
    expect(t).not.toContain(": —");
    expect(t.length).toBeGreaterThan(40);
  });
});
