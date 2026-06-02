// fix/dep-graph/js-ts-analyzer — JavaScript/TypeScript import analizi.
//
// TypeScript Compiler API (`ts.createSourceFile` — sadece syntax tree, full
// Program/type-checker DEĞİL → hızlı) ile import/export-from/require/dinamik
// import çıkarır. Regex YOK — gerçek AST. `typescript` runtime'da yüklü
// (paketli .app node_modules'a dahil + dependency). Lazy dynamic import:
// orchestrator açılışında yüklenmez, yalnız grafik kurulurken (Faz 0 D2).
// Yükleme başarısızsa null → grafik JavaScript/TypeScript'siz kalır (graceful).

import { dirname, join, resolve as resolvePath } from "node:path";
import { statSync } from "node:fs";
import type * as TsModule from "typescript";
import type { LanguageDependencyAnalyzer } from "./analyzer.js";
import { log } from "../../logger.js";

const JS_TS_EXTS = [
  ".ts", ".tsx", ".mts", ".cts",
  ".js", ".jsx", ".mjs", ".cjs",
] as const;

// Specifier çözümünde denenecek uzantı sırası + index dosyaları.
const RESOLVE_EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** base, base+ext, base/index+ext sırasıyla ilk var olan dosyayı döndür. */
function tryResolveFile(base: string): string | null {
  if (isFile(base)) return base;
  for (const ext of RESOLVE_EXTS) {
    if (isFile(base + ext)) return base + ext;
  }
  for (const ext of RESOLVE_EXTS) {
    const idx = join(base, `index${ext}`);
    if (isFile(idx)) return idx;
  }
  return null;
}

function scriptKind(ts: typeof TsModule, filePath: string): TsModule.ScriptKind {
  if (filePath.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (filePath.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (filePath.endsWith(".js") || filePath.endsWith(".mjs") || filePath.endsWith(".cjs"))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * JavaScript/TypeScript analyzer'ını üretir. `typescript` yüklenemezse null
 * (caller bu dili atlar, grafik yine de Python vb. ile kurulabilir).
 */
export async function createJsTsAnalyzer(): Promise<LanguageDependencyAnalyzer | null> {
  let ts: typeof TsModule;
  try {
    const mod = await import("typescript");
    ts = (mod as { default?: typeof TsModule }).default ?? (mod as unknown as typeof TsModule);
    if (typeof ts.createSourceFile !== "function") {
      log.warn("dep-graph", "typescript yüklendi ama API beklenmedik — JavaScript/TypeScript atlanıyor");
      return null;
    }
  } catch (err) {
    log.warn("dep-graph", "typescript yüklenemedi — JavaScript/TypeScript analizi atlanıyor", err);
    return null;
  }

  return {
    extensions: JS_TS_EXTS,

    extractImports(filePath: string, content: string): string[] {
      const specs: string[] = [];
      try {
        const sf = ts.createSourceFile(
          filePath,
          content,
          ts.ScriptTarget.Latest,
          /* setParentNodes */ false,
          scriptKind(ts, filePath),
        );
        const visit = (node: TsModule.Node): void => {
          // import ... from "x"  /  export ... from "x"
          if (
            (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
            node.moduleSpecifier &&
            ts.isStringLiteral(node.moduleSpecifier)
          ) {
            specs.push(node.moduleSpecifier.text);
          } else if (ts.isCallExpression(node)) {
            // require("x")  /  import("x") (dinamik)
            const isRequire =
              ts.isIdentifier(node.expression) && node.expression.text === "require";
            const isDynImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            if ((isRequire || isDynImport) && node.arguments.length > 0) {
              const arg = node.arguments[0];
              if (ts.isStringLiteral(arg)) specs.push(arg.text);
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      } catch (err) {
        log.warn("dep-graph", "ts parse failed (dosya atlandı)", {
          filePath,
          err: String(err),
        });
      }
      return specs;
    },

    resolveModule(specifier: string, fromFile: string, projectRoot: string): string | null {
      // Sadece proje içi (relative / absolute) — bare paket isimleri (react,
      // lodash) ve node: builtin'leri grafiğe girmez.
      if (specifier.startsWith(".")) {
        return tryResolveFile(resolvePath(dirname(fromFile), specifier));
      }
      if (specifier.startsWith("/")) {
        return tryResolveFile(resolvePath(projectRoot, `.${specifier}`));
      }
      return null;
    },
  };
}
