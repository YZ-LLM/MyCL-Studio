#!/usr/bin/env node
// home-guard — ev dizini ALTINDAKİ projelerde dosya araçlarının ARAÇ ANI muhafızı (Claude Code PreToolUse kancası).
//
// NEDEN (2026-11-26, gerçek claude 2.1.332 + macOS denemesi + mahkeme bulguları):
//   - Çekirdek kum havuzu (Seatbelt/bwrap) YALNIZ Bash'i kapsıyor. Read/Write/Edit/Glob/Grep araçlarını ev
//     dizininden uzak tutan tek şey izin kurallarıydı.
//   - Eski tek kural `Read(//<ev>)` alt ağacı da kapsıyor, ret izinden baskın → ev dizini altındaki projede
//     dosya araçları HER dosyada reddediliyordu. İzin kurallarında "şu dizin hariç" demenin yolu yok.
//   - Kardeşleri tek tek reddetmek (agent-sandbox.ts buildHomeReadDeny) projeyi açıyor ama liste spawn anında
//     alınıyor → henüz VAR OLMAYAN adlar (ör. `~/.zshenv`, `~/proj/CLAUDE.md`) yazma araçlarına açık kalıyordu.
//   Bu betik sayım yerine YÜKLEM uygular: hedef ev dizininin içindeyse ve projenin içinde değilse engel.
//   Var olmayan adlar, sembolik bağlantılar (boşta olanlar ve bağlantıdan sonra gelen ".." dahil), büyük küçük
//   harf ve Unicode farkları kapanır.
//   SINIR (dürüst): (1) sert bağlantı (hardlink) ayırt edilemez; (2) MCP araçları kanca eşleşmesinin dışında;
//   (3) YARIŞ: denetim araç çağrısından ÖNCE, ayrı süreçte yapılır. Ajan Bash ile proje içindeki bir bağlantıyı
//   arka planda sürekli değiştirirse (proje dosyası ↔ ev dizini dosyası) denetimle açılış arasına girebilir
//   (mahkeme 4. tur betikte gösterdi). Yol tabanlı hiçbir ön denetim bunu kapatamaz; kasıtlı bir saldırı gerektirir.
//   İzin kuralları (kardeş listesi) taban koruma olarak kalır: bu kanca hiç yüklenmezse var olan veri yine kapalı.
//
// GÜVENLİK TASARIMI (overlay-guard.mjs ile aynı ilkeler):
//   - Kurallar dosyadan okunmaz; argv'de base64 gelir (ajan çalışan sürecin argv'sini değiştiremez).
//   - HATA = ENGEL: kural çözülemiyor ya da araç yükü okunamıyorsa exit 2.
//   - Alan bilgisi taşımaz: ev dizini ve proje kökü MyCL'in hesapladığı veridir.
//   - Yetki alanı YALNIZ ev dizini: ev dizini dışındaki yollar (ör. /tmp, /usr) bu betiğin konusu değil → izin.
//
// Kullanım: node home-guard.mjs --rules <base64JSON>   (stdin: PreToolUse araç yükü)
// Kural şeması: { home: string, project_root: string }   — ikisi de mutlak yol.
// Sözleşme: exit 0 → izin, exit 2 → engel (stderr modele döner).

import { lstatSync, readlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

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
const rulesIdx = argv.indexOf("--rules");
if (rulesIdx === -1 || !argv[rulesIdx + 1]) {
  block("home guard: rules argument missing (fail-closed).");
}

let rules;
try {
  rules = JSON.parse(Buffer.from(argv[rulesIdx + 1], "base64").toString("utf-8"));
  if (typeof rules !== "object" || rules === null) throw new Error("rules not an object");
} catch (e) {
  block(`home guard: rules could not be decoded (${String(e)}) — failing closed.`);
}

const home = typeof rules.home === "string" ? rules.home : "";
const projectRoot = typeof rules.project_root === "string" ? rules.project_root : "";
if (!home || !isAbsolute(home) || !projectRoot || !isAbsolute(projectRoot)) {
  block("home guard: home/project_root invalid — failing closed.");
}

const raw = await readStdin();
let payload;
try {
  payload = JSON.parse(raw);
  if (typeof payload !== "object" || payload === null) throw new Error("payload not an object");
} catch {
  block("home guard: tool payload unreadable — failing closed.");
}

const toolInput =
  typeof payload.tool_input === "object" && payload.tool_input !== null ? payload.tool_input : {};
const cwd = typeof payload.cwd === "string" && isAbsolute(payload.cwd) ? payload.cwd : projectRoot;

// FİZİKSEL YOL ÇÖZÜMÜ. Yol METİN olarak sadeleştirilmez; kökten başlayıp parça parça yürünür:
//   - sembolik bağlantı görülürse hedefi izlenir (boşta bağlantı dahil: `proje/x -> ~/olmayan`),
//   - ".." ancak o ana kadarki GERÇEK dizinin üstüne çıkar. Metin sadeleştirmesi `proje/baglanti/../a.txt`
//     yolunu `proje/a.txt` sanardı; işletim sistemi ise bağlantının hedefinin üstüne gider (mahkeme 3. tur — betikte
//     ve ham işletim sistemi çözümünde gösterildi; gerçek claude 2.1.332'de Write yolu kendisi metin olarak
//     sadeleştirdi ve dosya projede kaldı, diğer araçlar ölçülmedi). Muhafız bilerek katı okumayı seçer.
//   - var olmayan parça olduğu gibi eklenir (yeni dosya/dizin); sonrasındaki ".." yine bir üst dizine çıkar.
// Döngüye karşı toplam bağlantı izleme sayısı sınırlıdır; aşılırsa HATA = ENGEL.
let linkBudget = 64;
function physical(absPath) {
  let cur = "/";
  const queue = absPath.split("/");
  while (queue.length > 0) {
    const seg = queue.shift();
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      cur = dirname(cur);
      continue;
    }
    const next = join(cur, seg);
    let linkTarget = null;
    try {
      if (lstatSync(next).isSymbolicLink()) linkTarget = readlinkSync(next);
    } catch {
      linkTarget = null; // yok (ya da erişilemiyor) → olduğu gibi eklenir
    }
    if (linkTarget === null) {
      cur = next;
      continue;
    }
    if (--linkBudget < 0) block("home guard: too many symbolic links — failing closed.");
    // Bağlantı hedefi: mutlaksa kökten, göreliyse bağlantının bulunduğu GERÇEK dizinden yürünür.
    const targetSegs = linkTarget.split("/");
    if (isAbsolute(linkTarget)) cur = "/";
    queue.unshift(...targetSegs);
  }
  return cur;
}
/** Göreli yolu cwd'ye METİN sadeleştirmesi yapmadan ekle, sonra fiziksel çöz. */
function physicalFrom(base, p) {
  return physical(isAbsolute(p) ? p : `${base}/${p}`);
}
const CASE_FOLD = process.platform === "darwin";
const canon = (s) => {
  const n = s.normalize("NFC");
  return CASE_FOLD ? n.toLowerCase() : n;
};
/** child, parent'ın kendisi ya da altında mı (kanonik, büyük küçük harf / Unicode katlanmış). */
function isInside(child, parent) {
  const rel = relative(canon(parent), canon(child)).split(sep).join("/");
  return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
}

const realHome = physical(home);
const realProject = physical(projectRoot);

// DOSYA KİMLİĞİ (mahkeme 4. tur, YÜKSEK): aynı dizine METNİ farklı yollarla da varılır ve bunlar sembolik bağlantı
// değildir → physical() onları açamaz. macOS'ta /Users ve /private birer "firmlink"tir: `/System/Volumes/Data/Users/<ben>`
// ev dizininin TA KENDİSİDİR (aynı aygıt + inode; ölçüldü). Linux'ta bind mount aynı etkiyi yapar. Bu yüzden metin
// karşılaştırmasına EK olarak kimlik karşılaştırması yapılır: hedefin var olan en yakın atasından köke doğru çıkılır,
// atalardan biri ev dizini (ya da proje) ile aynı aygıt + inode ise hedef onun içindedir.
function fileId(p) {
  try {
    const st = statSync(p);
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}
const homeId = fileId(realHome);
const projectId = fileId(realProject);
function insideById(target, rootId) {
  if (rootId === null) return false;
  let p = target;
  for (let i = 0; i < 4096; i++) {
    if (fileId(p) === rootId) return true; // var olmayan parça null döner → üst dizine çıkılır
    const parent = dirname(p);
    if (parent === p) return false;
    p = parent;
  }
  return false;
}
/** Hedef, kökün içinde mi: metin (fiziksel yol) YA DA dosya kimliği ile. */
function within(target, rootPath, rootId) {
  return isInside(target, rootPath) || insideById(target, rootId);
}
/** Hedef ev dizininin atası mı (üzerinde arama ev dizinini de tarar): metin, kimlik ya da macOS veri birimi takma yolu. */
function containsHome(target) {
  if (isInside(realHome, target)) return true;
  const targetId = fileId(target);
  if (targetId !== null && insideById(realHome, targetId)) return true;
  // `/System/Volumes/Data` ev dizininin metin atası DEĞİL, kimlik atası da değil (ayrı birim kökü) ama altında
  // `Users/<ben>` vardır → takma yolun atası olan hedef de ev dizinini tarar.
  return process.platform === "darwin" && isInside(`/System/Volumes/Data${realHome}`, target);
}
// macOS çekirdeğinin sihirli yol önekleri: `/.vol/<aygıt>/<inode>` dosyaya adı olmadan, `/.nofollow/…` ve
// `/.resolve/<n>/…` aynı dosyaya başka metinle ulaşır. Kimlik yürüyüşü `/.vol` için işe yaramaz (üst dizini yok).
// Bir kodlama ajanının bu önekleri kullanması için meşru neden yok → HATA = ENGEL.
const DARWIN_MAGIC_PREFIXES = ["/.vol", "/.nofollow", "/.resolve"];
function isMagicPath(resolved) {
  if (process.platform !== "darwin") return false;
  const c = canon(resolved);
  return DARWIN_MAGIC_PREFIXES.some((m) => c === m || c.startsWith(`${m}/`));
}

// `~` ile başlayan yol: araç onu genişletirse ev dizinine gider → genişletilmiş hâline bakılır.
function expandTilde(p) {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Glob deseninin desen karakterinden ÖNCEKİ sabit dizin öneki (ör. "/Users/x/**/*.pem" → "/Users/x").
// REGEX YOK — düz döngü. Önek yoksa (göreli desen) boş döner; o durumda arama kökü `path`/cwd'dir.
function staticPrefix(pattern) {
  let cut = pattern.length;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++; // kaçırılmış karakter düz karakterdir (ör. "app \\[v2\\]/src")
      continue;
    }
    if (ch === "*" || ch === "?" || ch === "[" || ch === "{") {
      cut = i;
      break;
    }
  }
  const head = pattern.slice(0, cut);
  if (cut === pattern.length) return head; // desen karakteri yok → yolun tamamı
  const slash = head.lastIndexOf("/");
  return slash === -1 ? "" : head.slice(0, slash + 1);
}

/** Sabit önekteki kaçış ters eğik çizgilerini kaldır ("app \\[v2\\]/" → "app [v2]/"). REGEX YOK. */
function unescapeGlob(prefix) {
  let out = "";
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] === "\\" && i + 1 < prefix.length) i++;
    out += prefix[i];
  }
  return out;
}

// Desen karakterinden SONRA gelen bir parçada ".." varsa (ör. "src/*/../../..", "{../..,x}") desenin nereye
// çıkacağı sabit önekten anlaşılamaz → emin değilsek engel.
function hasDotDotAfterGlob(pattern) {
  let seenGlob = false;
  for (const seg of pattern.split("/")) {
    if (seenGlob && seg.includes("..")) return true;
    if (seg.includes("*") || seg.includes("?") || seg.includes("[") || seg.includes("{")) {
      if (seg.includes("..")) return true;
      // Desen sözdizimiyle gizlenmiş ".." (ör. ".{.,}", "[.][.]", "{.,..}"): sözdizimi karakterleri atılınca
      // geriye yalnız iki ya da daha çok nokta kalıyorsa parça ".." olarak açılabilir. ("*.{ts,tsx}", ".*", "*.*.*" kalmaz.)
      let rest = "";
      for (const ch of seg) {
        // `*` ve `?` ATILMAZ: "*.*.*" ya da ".*.*" (çift uzantı, noktalı dosya) ".." olarak açılamaz (4. tur: haksız engel).
        if (ch !== "{" && ch !== "}" && ch !== "[" && ch !== "]" && ch !== ",") rest += ch;
      }
      let onlyDots = rest.length >= 2;
      for (const ch of rest) if (ch !== ".") onlyDots = false;
      if (onlyDots) return true;
      seenGlob = true;
    }
  }
  return false;
}

// Denetlenecek hedefler. Read/Write/Edit/MultiEdit → file_path; NotebookEdit → notebook_path;
// Glob/Grep → path (yoksa cwd) + Glob deseninin mutlak öneki.
const targets = [];
for (const key of ["file_path", "notebook_path", "path"]) {
  const v = toolInput[key];
  if (typeof v === "string" && v.trim() !== "") targets.push(v);
}
// Arama kökü: `path` verildiyse o, yoksa cwd. Göreli desen bu köke göre çözülür.
const searchBase =
  typeof toolInput.path === "string" && toolInput.path.trim() !== ""
    ? (isAbsolute(expandTilde(toolInput.path)) ? expandTilde(toolInput.path) : `${cwd}/${toolInput.path}`)
    : cwd;
// `pattern` YALNIZ dosya deseni olduğunda yol gibi denetlenir. Grep'te `pattern` düzenli ifadedir: "../components",
// "//.*eslint-disable", "{...props} />" gibi gündelik aramaları yol sanmak onları haksız yere engelliyordu
// (mahkeme 3. tur). Grep'in arama yeri `path` alanıdır ve yukarıda denetlenir. Araç adı bilinmiyorsa
// güvenli taraf: desen gibi denetle.
const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
if (toolName !== "Grep" && typeof toolInput.pattern === "string" && toolInput.pattern !== "") {
  const expanded = expandTilde(toolInput.pattern);
  if (hasDotDotAfterGlob(expanded)) {
    block(`home guard: pattern "${toolInput.pattern}" climbs with ".." after a wildcard. Search inside the project (${projectRoot}) instead.`);
  }
  // Sabit önek — göreli de olsa — arama köküne göre çözülüp denetlenir (ör. "../../**/*.txt").
  // Proje yolunun KENDİSİNDE desen karakteri varsa (ör. "~/işler/app [v2]") mutlak desenin sabit öneki projenin
  // üstünde kesilir ve projenin kendi dosyaları haksız yere engellenirdi (4. tur). Desen proje köküyle başlıyorsa
  // kök düz metin sayılır, önek kalan kısımdan hesaplanır (kalan kısımdaki ".." yine fiziksel çözülür).
  const rootPrefix = [projectRoot, realProject].find((r) => canon(expanded).startsWith(`${canon(r)}/`));
  if (rootPrefix !== undefined) {
    targets.push(`${rootPrefix}/${unescapeGlob(staticPrefix(expanded.slice(rootPrefix.length + 1)))}`);
  } else {
    const prefix = unescapeGlob(staticPrefix(expanded));
    if (isAbsolute(expanded)) targets.push(prefix === "" ? "/" : prefix);
    else if (prefix !== "") targets.push(`${searchBase}/${prefix}`);
  }
}
if (targets.length === 0) {
  // Yol vermeyen arama (Glob/Grep) cwd'de koşar; yol vermeyen yazma/okuma aracı beklenmedik → cwd denetlenir.
  targets.push(cwd);
}

for (const t of targets) {
  const resolved = physicalFrom(cwd, expandTilde(t));
  if (isMagicPath(resolved)) {
    block(`home guard: "${t}" uses a special system path prefix. Use the normal path inside the project (${projectRoot}).`);
  }
  if (within(resolved, realProject, projectId)) continue; // proje: serbest (proje içi korumalar ayrı kurallarda)
  if (within(resolved, realHome, homeId)) {
    block(
      `home guard: "${t}" is inside the user's home directory but outside the project (${projectRoot}). ` +
        `File tools may only touch the project; use a path (or a relative pattern with path) inside the project.`,
    );
  }
  // Ev dizininin ATASI (ör. "/" ya da "/Users") üzerinde arama → ev dizinini de tarar: engel.
  if (containsHome(resolved)) {
    block(
      `home guard: "${t}" contains the user's home directory. Search inside the project (${projectRoot}) instead.`,
    );
  }
}

process.exit(0);
