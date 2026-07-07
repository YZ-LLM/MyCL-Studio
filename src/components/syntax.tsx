// syntax — YZLLM 2026-07-07: CodeModal "Kodu göster" popup'u için HAFİF söz dizimi renklendirmesi.
//
// Dış bağımlılık YOK (proje dep-minimal) + CSP-güvenli (yalnız class'lı <span>, inline-eval yok). Dile göre:
// HTML özel tokenizer (etiket/attr/değer/yorum), diğer kodlar ortak soldan-sağa tokenizer (yorum/string/sayı/
// keyword). Bilinmeyen dil → düz metin (renk yok). Tokenizer ASLA throw etmez (hata → düz metin fallback).
//
// Snippet formatı (error-analysis.ts): her satır `"  250 | <kod>"` (padStart(4) numara + " | " + kod). Gutter
// (satır no) AYRILIR + soluk gösterilir; yalnız KOD renklenir. Çok-satırlı token (blok yorum / şablon-string /
// çok satıra yayılan etiket) satırlara doğru dağıtılır (token birleşik tokenize edilip '\n' ile bölünür).

import type { ReactNode } from "react";

export type Lang =
  | "html"
  | "css"
  | "js"
  | "json"
  | "python"
  | "go"
  | "rust"
  | "shell"
  | "sql"
  | "yaml"
  | "plain";

const EXT_LANG: Record<string, Lang> = {
  html: "html", htm: "html", xml: "html", svg: "html", vue: "html", xhtml: "html",
  css: "css", scss: "css", sass: "css", less: "css",
  js: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", tsx: "js", mts: "js", cts: "js",
  json: "json", jsonc: "json",
  py: "python", pyi: "python",
  go: "go",
  rs: "rust",
  sh: "shell", bash: "shell", zsh: "shell",
  sql: "sql",
  yml: "yaml", yaml: "yaml",
};

/** Dosya yolundan dili tespit et (uzantı). Bilinmeyen → "plain". SAF. */
export function langFromFile(file: string): Lang {
  const m = /\.([a-z0-9]+)\s*$/i.exec(file.trim());
  const ext = m ? m[1].toLowerCase() : "";
  return EXT_LANG[ext] ?? "plain";
}

type TokType =
  | "comment"
  | "string"
  | "keyword"
  | "number"
  | "tag"
  | "attr"
  | "func"
  | "punct"
  | "text";

interface Tok {
  t: TokType;
  v: string;
}

interface GenCfg {
  lineComment: string[];
  blockComment?: [string, string];
  strings: string[];
  keywords: Set<string>;
}

const kw = (s: string): Set<string> => new Set(s.split(/\s+/).filter(Boolean));

const KW_JS = kw(`const let var function return if else for while do switch case break continue new class
  extends super this typeof instanceof in of await async yield import export from default try catch finally throw
  delete void null undefined true false interface type enum implements public private protected readonly static
  get set as namespace declare abstract satisfies keyof infer never unknown any string number boolean object symbol`);
const KW_PY = kw(`def class return if elif else for while import from as try except finally raise with lambda yield
  global nonlocal pass break continue and or not in is None True False async await del assert match case`);
const KW_GO = kw(`func var const type struct interface map chan go defer return if else for range switch case break
  continue package import nil true false select fallthrough goto default`);
const KW_RUST = kw(`fn let mut const static struct enum impl trait pub use mod match if else for while loop return
  break continue self Self ref move async await where dyn as in true false None Some Ok Err crate super unsafe`);
const KW_SHELL = kw(`if then else elif fi for while do done case esac function return in select until echo local export`);
const KW_SQL = kw(`SELECT FROM WHERE INSERT UPDATE DELETE CREATE TABLE ALTER DROP JOIN LEFT RIGHT INNER OUTER FULL ON
  GROUP BY ORDER HAVING LIMIT OFFSET AS AND OR NOT NULL PRIMARY KEY FOREIGN REFERENCES INDEX INTO VALUES SET DISTINCT
  UNION ALL EXISTS BETWEEN LIKE IN IS ASC DESC DEFAULT AUTOINCREMENT UNIQUE CONSTRAINT`);

const CFG: Record<Exclude<Lang, "html" | "plain">, GenCfg> = {
  js: { lineComment: ["//"], blockComment: ["/*", "*/"], strings: ['"', "'", "`"], keywords: KW_JS },
  css: { lineComment: [], blockComment: ["/*", "*/"], strings: ['"', "'"], keywords: kw("") },
  json: { lineComment: [], strings: ['"'], keywords: kw("true false null") },
  python: { lineComment: ["#"], strings: ['"', "'"], keywords: KW_PY },
  go: { lineComment: ["//"], blockComment: ["/*", "*/"], strings: ['"', "`"], keywords: KW_GO },
  rust: { lineComment: ["//"], blockComment: ["/*", "*/"], strings: ['"'], keywords: KW_RUST },
  shell: { lineComment: ["#"], strings: ['"', "'"], keywords: KW_SHELL },
  sql: { lineComment: ["--"], blockComment: ["/*", "*/"], strings: ["'"], keywords: KW_SQL },
  yaml: { lineComment: ["#"], strings: ['"', "'"], keywords: kw("true false null yes no on off") },
};

/** Ortak kod tokenizer (soldan-sağa, öncelik: blok-yorum > satır-yorum > string > sayı > keyword/ident > punct). */
function tokenizeGeneric(code: string, cfg: GenCfg): Tok[] {
  const out: Tok[] = [];
  const n = code.length;
  let i = 0;
  let buf = "";
  const flush = (): void => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };
  const isKwCI = cfg.keywords.size > 0 && [...cfg.keywords].some((k) => k !== k.toLowerCase());
  while (i < n) {
    const c = code[i];
    if (cfg.blockComment && code.startsWith(cfg.blockComment[0], i)) {
      flush();
      const end = code.indexOf(cfg.blockComment[1], i + cfg.blockComment[0].length);
      const stop = end < 0 ? n : end + cfg.blockComment[1].length;
      out.push({ t: "comment", v: code.slice(i, stop) });
      i = stop;
      continue;
    }
    const lc = cfg.lineComment.find((p) => code.startsWith(p, i));
    if (lc) {
      flush();
      const end = code.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      out.push({ t: "comment", v: code.slice(i, stop) });
      i = stop;
      continue;
    }
    if (cfg.strings.includes(c)) {
      flush();
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === c) {
          j++;
          break;
        }
        j++;
      }
      out.push({ t: "string", v: code.slice(i, Math.min(j, n)) });
      i = Math.min(j, n);
      continue;
    }
    if (c >= "0" && c <= "9") {
      flush();
      let j = i + 1;
      while (j < n && /[0-9a-fA-F.xXeEbo_]/.test(code[j])) j++;
      out.push({ t: "number", v: code.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_$@]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$-]/.test(code[j])) j++;
      const word = code.slice(i, j);
      const isKw = cfg.keywords.has(word) || (isKwCI && cfg.keywords.has(word.toUpperCase()));
      const isFn = !isKw && code[j] === "(";
      if (isKw || isFn) {
        flush();
        out.push({ t: isKw ? "keyword" : "func", v: word });
      } else {
        buf += word;
      }
      i = j;
      continue;
    }
    // punct (tek karakter) veya boşluk → buf; punctuation'ı ayrı renklendirme (default fg yeterli, gürültü olmasın)
    buf += c;
    i++;
  }
  flush();
  return out;
}

/** HTML/XML tokenizer: yorum, etiket (ad/attr/değer), entity, metin. */
function tokenizeHtml(code: string): Tok[] {
  const out: Tok[] = [];
  const n = code.length;
  let i = 0;
  let buf = "";
  const flush = (): void => {
    if (buf) {
      out.push({ t: "text", v: buf });
      buf = "";
    }
  };
  const push = (t: TokType, v: string): void => {
    flush();
    if (v) out.push({ t, v });
  };
  while (i < n) {
    if (code.startsWith("<!--", i)) {
      const end = code.indexOf("-->", i + 4);
      const stop = end < 0 ? n : end + 3;
      push("comment", code.slice(i, stop));
      i = stop;
      continue;
    }
    if (code[i] === "<") {
      push("punct", "<");
      i++;
      if (code[i] === "/" || code[i] === "!") {
        push("punct", code[i]);
        i++;
      }
      let k = i;
      while (k < n && /[\w:.-]/.test(code[k])) k++;
      if (k > i) {
        push("tag", code.slice(i, k));
        i = k;
      }
      while (i < n && code[i] !== ">") {
        const c = code[i];
        if (c === "/") {
          push("punct", "/");
          i++;
        } else if (c === "=") {
          push("punct", "=");
          i++;
        } else if (c === '"' || c === "'") {
          let m = i + 1;
          while (m < n && code[m] !== c) m++;
          push("string", code.slice(i, Math.min(m + 1, n)));
          i = Math.min(m + 1, n);
        } else if (/\s/.test(c)) {
          buf += c;
          i++;
        } else {
          let a = i;
          while (a < n && !/[\s=>/'"]/.test(code[a])) a++;
          if (a > i) {
            push("attr", code.slice(i, a));
            i = a;
          } else {
            push("punct", c);
            i++;
          }
        }
      }
      if (i < n && code[i] === ">") {
        push("punct", ">");
        i++;
      }
      continue;
    }
    if (code[i] === "&") {
      let j = i + 1;
      while (j < n && /[\w#]/.test(code[j])) j++;
      if (code[j] === ";") {
        push("string", code.slice(i, j + 1));
        i = j + 1;
        continue;
      }
    }
    buf += code[i];
    i++;
  }
  flush();
  return out;
}

const CLASS: Record<TokType, string> = {
  comment: "hl-comment",
  string: "hl-string",
  keyword: "hl-keyword",
  number: "hl-number",
  tag: "hl-tag",
  attr: "hl-attr",
  func: "hl-func",
  punct: "",
  text: "",
};

const GUTTER_RE = /^(\s*\d+ \| )(.*)$/;

/**
 * Gutter'lı snippet'i ("  250 | kod") satır-no + renklenmiş kod olarak render eder. lang="plain" veya tokenizer
 * hata verirse renksiz düz metin (gutter yine soluk). SAF — DOM string enjekte etmez (yalnız React <span>'ler).
 */
export function highlightSnippet(snippet: string, lang: Lang): ReactNode {
  const rawLines = snippet.split("\n");
  const gutters: string[] = [];
  const codes: string[] = [];
  for (const line of rawLines) {
    const m = GUTTER_RE.exec(line);
    if (m) {
      gutters.push(m[1]);
      codes.push(m[2]);
    } else {
      gutters.push("");
      codes.push(line);
    }
  }
  const code = codes.join("\n");
  let tokens: Tok[];
  try {
    tokens =
      lang === "plain"
        ? [{ t: "text", v: code }]
        : lang === "html"
          ? tokenizeHtml(code)
          : tokenizeGeneric(code, CFG[lang]);
  } catch {
    tokens = [{ t: "text", v: code }]; // fail-soft: renksiz düz metin
  }
  // Token'ları satırlara dağıt ('\n' sınırı → sonraki satır).
  const lineNodes: ReactNode[][] = codes.map(() => []);
  let li = 0;
  let key = 0;
  for (const tok of tokens) {
    const parts = tok.v.split("\n");
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) li++;
      const seg = parts[p];
      if (!seg || li >= lineNodes.length) continue;
      const cls = CLASS[tok.t];
      lineNodes[li].push(cls ? <span key={key++} className={cls}>{seg}</span> : seg);
    }
  }
  return lineNodes.map((nodes, idx) => (
    <span key={idx}>
      <span className="hl-gutter">{gutters[idx]}</span>
      {nodes}
      {idx < lineNodes.length - 1 ? "\n" : ""}
    </span>
  ));
}
