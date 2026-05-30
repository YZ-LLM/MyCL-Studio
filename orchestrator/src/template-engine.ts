// template-engine — basit {{VAR}} substitution. Spec §7.5.
//
// Syntax:
//   {{VAR_NAME}}        → basit replace
//   {{VAR_NAME|raw}}    → markdown güvenli replace (special char escape)
//   {{VAR_NAME|json}}   → JSON encode (string olarak inline edilir)
//
// Bilinmeyen variable → throws TemplateError (fallback YASAK; sessizce boş
// string dönmek hatayı gizler ve template'ler runtime'da kötü doldurulur).
// Bilinmeyen modifier  → throws.

export type TemplateVars = Record<string, string | number | boolean>;

const TOKEN_RE = /\{\{(\w+)(?:\|(\w+))?\}\}/g;

const MD_SPECIAL_RE = /([\\`*_{}[\]()#+\-.!|>~])/g;

function escapeMarkdown(s: string): string {
  return s.replace(MD_SPECIAL_RE, "\\$1");
}

export class TemplateError extends Error {
  override readonly name = "TemplateError";
}

export function substitute(template: string, vars: TemplateVars): string {
  return template.replace(TOKEN_RE, (_match, name: string, modifier?: string) => {
    const raw = vars[name];
    if (raw === undefined) {
      throw new TemplateError(
        `unknown variable "${name}" — caller must provide it (no silent fallback)`,
      );
    }
    const value = String(raw);
    if (!modifier) return value;
    switch (modifier) {
      case "raw":
        return escapeMarkdown(value);
      case "json":
        return JSON.stringify(value);
      default:
        throw new TemplateError(
          `unknown modifier "${modifier}" for variable "${name}"`,
        );
    }
  });
}
