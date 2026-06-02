// fix/dep-graph/python-analyzer — Python import analizi (hafif, satır-temelli).
//
// Python import sözdizimi satır başında basittir → AST parser gerekmez, regex
// YOK (leading-token kontrolü). `import a.b.c [as x]`, `from a.b import x`,
// `from . import y`, `from .mod import z` desenlerini çıkarır. Çözümleme
// best-effort: relative (leading-dot) + aynı-proje absolute dotted path →
// dosya. 3rd-party / stdlib → null.

import { dirname, join } from "node:path";
import { statSync } from "node:fs";
import type { LanguageDependencyAnalyzer } from "./analyzer.js";

const PY_EXTS = [".py"] as const;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** İlk var olan: base.py veya base/__init__.py. */
function tryResolvePy(base: string): string | null {
  if (isFile(`${base}.py`)) return `${base}.py`;
  const initPy = join(base, "__init__.py");
  if (isFile(initPy)) return initPy;
  return null;
}

export function createPythonAnalyzer(): LanguageDependencyAnalyzer {
  return {
    extensions: PY_EXTS,

    extractImports(_filePath: string, content: string): string[] {
      const specs: string[] = [];
      for (const raw of content.split("\n")) {
        const line = raw.trim();
        if (line.length === 0 || line.startsWith("#")) continue;

        if (line.startsWith("import ")) {
          // "import a.b, c.d as e" → ["a.b", "c.d"]
          const rest = line.slice("import ".length);
          for (const part of rest.split(",")) {
            const mod = part.trim().split(" ")[0]; // " as " öncesi ilk token
            if (mod) specs.push(mod);
          }
        } else if (line.startsWith("from ")) {
          // "from a.b import x"  /  "from . import y"  /  "from .mod import z"
          const afterFrom = line.slice("from ".length);
          const idx = afterFrom.indexOf(" import ");
          if (idx >= 0) {
            const mod = afterFrom.slice(0, idx).trim();
            if (mod) specs.push(mod);
          }
        }
      }
      return specs;
    },

    resolveModule(specifier: string, fromFile: string, projectRoot: string): string | null {
      let baseDir: string;
      let rest: string;
      if (specifier.startsWith(".")) {
        // Leading-dot sayısı = relative seviye. 1 nokta = aynı paket, her ek
        // nokta bir üst.
        let dots = 0;
        while (dots < specifier.length && specifier[dots] === ".") dots++;
        rest = specifier.slice(dots);
        let dir = dirname(fromFile);
        for (let i = 1; i < dots; i++) dir = dirname(dir);
        baseDir = dir;
      } else {
        rest = specifier;
        baseDir = projectRoot;
      }
      const relPath = rest.length > 0 ? rest.split(".").join("/") : "";
      const base = relPath ? join(baseDir, relPath) : baseDir;
      return tryResolvePy(base);
    },
  };
}
