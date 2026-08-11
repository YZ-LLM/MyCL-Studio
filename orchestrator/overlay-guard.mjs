#!/usr/bin/env node
// overlay-guard — iterasyon gate overlay'inin ARAÇ ANI muhafızı (Claude Code PreToolUse kancası).
//
// NEDEN (2026-08-04, gate overlay planı): overlay'in "dosya odaklı" gate'leri (file_immutable,
// forbid_new_files, forbid_dependency_change) yazma aracı ÇAĞRILDIĞI anda uygulanmalı — iş bittikten
// sonra tespit etmek geç. Claude Code sözleşmesi: PreToolUse kancası exit 0 → izin, exit 2 → engel
// (stderr metni modele geri döner; model engeli görüp yaklaşımını değiştirir).
//
// GÜVENLİK TASARIMI (bilinçli, değiştirme):
// - Kurallar DOSYADAN OKUNMAZ; komut satırında base64 gömülü gelir. Proje içindeki her dosyaya
//   (.mycl dahil) kod yazan ajan dokunabilir — kural dosyası olsaydı ajan kendi kilidini silebilirdi.
//   Çalışan sürecin argv'sini ise değiştiremez → kurallar iterasyon boyunca DONUK kalır (AD-3).
// - Bu betik alan bilgisi taşımaz: hangi dosyalar korunuyor, bağımlılık dosyası adları — hepsi
//   MyCL'in derleme anında hesapladığı VERİ olarak gelir. Tek doğruluk kaynağı orkestratördür.
// - HATA = ENGEL (fail-closed): kurallar çözülemiyorsa ya da araç yükü beklenmedikse exit 2.
//   Ayar bloğu Claude tarafından sessizce yutulursa zaten hiç çağrılmayız (o delik için ayrı
//   kanarya var: --ack). Çağrıldıysak ve emin değilsek, "yazmaya izin" en yanlış cevap olur.
//   Patlama yarıçapı ayarlardaki matcher ile YALNIZ yazma araçlarına sınırlı — okuma/Bash'e
//   bu betik hiç uygulanmaz (Bash tarafı için pipeline sonunda taban çizgisi kontrolü var).
//
// Kullanım:
//   node overlay-guard.mjs --ack <işaretDosyası>       (SessionStart kanaryası: işaret yaz, exit 0)
//   node overlay-guard.mjs --rules <base64JSON>        (PreToolUse: stdin'den araç yükünü oku, karar ver)
//
// Kural şeması (MyCL üretir): { project_root: string, immutable: string[],
//   no_new_files: string[], dependency_file_names: string[] }  — yollar proje köküne göre, "/" ayraçlı.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

function readStdin() {
  return new Promise((resolveP) => {
    let data = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolveP(data));
    process.stdin.on("error", () => resolveP(data));
  });
}

function block(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);

// ── Kanarya: SessionStart'ta işaret dosyası yaz. Claude ayar bloğunu ŞEMA hatasında sessizce
// yok sayıyor (ampirik, 2.1.227) — işaret yoksa MyCL "kancalar hiç yüklenmedi" diye anlar ve
// iterasyonu gürültülü durdurur (KATI #4: kapısız iterasyon sessizce koşamaz).
const ackIdx = argv.indexOf("--ack");
if (ackIdx !== -1) {
  const marker = argv[ackIdx + 1];
  try {
    if (marker) {
      mkdirSync(dirname(marker), { recursive: true });
      writeFileSync(marker, JSON.stringify({ at: Date.now(), pid: process.pid }) + "\n", "utf-8");
    }
  } catch (e) {
    // Kanarya yazılamadı → MyCL işareti bulamayınca zaten görünür şekilde duracak; burada
    // ayrıca engel üretmek SessionStart'ta anlamsız (bloklayacak araç çağrısı yok).
    process.stderr.write(`overlay-guard ack yazilamadi: ${String(e)}\n`);
  }
  process.exit(0);
}

const rulesIdx = argv.indexOf("--rules");
if (rulesIdx === -1 || !argv[rulesIdx + 1]) {
  block("gate-overlay guard: rules argument missing (fail-closed).");
}

let rules;
try {
  rules = JSON.parse(Buffer.from(argv[rulesIdx + 1], "base64").toString("utf-8"));
  if (typeof rules !== "object" || rules === null) throw new Error("rules not an object");
} catch (e) {
  block(`gate-overlay guard: rules could not be decoded (${String(e)}) — failing closed.`);
}

const projectRoot = typeof rules.project_root === "string" ? rules.project_root : "";
const immutable = Array.isArray(rules.immutable) ? rules.immutable.filter((p) => typeof p === "string") : [];
const noNewFiles = Array.isArray(rules.no_new_files)
  ? rules.no_new_files.filter((p) => typeof p === "string")
  : [];
const depNames = Array.isArray(rules.dependency_file_names)
  ? rules.dependency_file_names.filter((p) => typeof p === "string")
  : [];
if (!projectRoot || !isAbsolute(projectRoot)) {
  block("gate-overlay guard: project_root invalid — failing closed.");
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  block("gate-overlay guard: tool payload unreadable — failing closed.");
}

const toolInput = payload && typeof payload.tool_input === "object" && payload.tool_input !== null
  ? payload.tool_input
  : {};
// Yazma araçlarının dosya alanları: Write/Edit/MultiEdit → file_path, NotebookEdit → notebook_path.
const targetRaw = toolInput.file_path ?? toolInput.notebook_path ?? toolInput.path;
if (typeof targetRaw !== "string" || targetRaw.trim() === "") {
  block("gate-overlay guard: write tool without a file path — failing closed.");
}

// Yolu proje köküne göre çöz ve normalize et. `sub/../x` gibi dolambaçlar resolve ile düzleşir —
// dondurulmuş dosyaya dolaylı yoldan yazmak engeli aşamaz.
const resolved = resolve(projectRoot, targetRaw);
const rel = relative(projectRoot, resolved).split(sep).join("/");
if (rel.startsWith("..") || rel === "") {
  // Proje DIŞI yol: overlay'in yetki alanı proje; dışarıyı zaten kum havuzu yönetiyor.
  process.exit(0);
}

for (const frozen of immutable) {
  if (rel === frozen) {
    block(
      `gate-overlay: "${rel}" is frozen for this iteration (file_immutable). Do not modify it; solve the task another way.`,
    );
  }
}

if (depNames.includes(basename(rel))) {
  block(
    `gate-overlay: dependency files may not change this iteration (forbid_dependency_change). "${rel}" is a dependency file.`,
  );
}

for (const dir of noNewFiles) {
  // "." = proje kökü = TÜM proje (envanter kökü dizin olarak sunar, model seçebilir). Bu satır
  // olmadan kök seçimi hiçbir şeyi engellemiyordu — kullanıcı korunduğunu sanırken korunmazdı
  // (mahkeme öncesi gözden geçirme bulgusu, 2026-08-11). decide.ts İKİZİYLE birlikte değişti.
  const inDir = dir === "." || rel === dir || rel.startsWith(`${dir}/`);
  if (inDir && !existsSync(resolved)) {
    block(
      `gate-overlay: creating new files under "${dir}" is forbidden this iteration (forbid_new_files). Edit existing files instead.`,
    );
  }
}

process.exit(0);
