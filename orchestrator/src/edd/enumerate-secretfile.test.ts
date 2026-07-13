import { describe, it, expect } from "vitest";
import { isSecretFile } from "./enumerate.js";

// EDD sır-dosyalarını analiz etmemeli (içeriğini .mycl notuna alıntılayıp committable dosyaya sızdırmasın).
describe("isSecretFile — sır dosyalarını YAKALAR (EDD ingest etmez)", () => {
  const secrets = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.example", // template de atlanır (yanlışlıkla gerçek değer içerebilir; davranış değil)
    "server.pem",
    "private.key",
    "cert.p12",
    "store.pfx",
    "app.keystore",
    "keys.jks",
    "id_rsa",
    "id_ed25519",
    "id_rsa.pub",
    ".npmrc",
    ".netrc",
    ".pgpass",
    ".htpasswd",
    "secrets.json",
    "secret.yaml",
    "secrets.env",
    "credentials.json",
    "credential.ini",
  ];
  for (const f of secrets) {
    it(`yakalar: ${f}`, () => expect(isSecretFile(f)).toBe(true));
  }
});

describe("isSecretFile — MEŞRU kaynak/config dosyalarını KORUR (EDD analiz eder)", () => {
  const sources = [
    "app.js",
    "index.ts",
    "credentialService.js", // 'credential' geçiyor ama kaynak — anchored regex EŞLEŞMEZ
    "keyboardHandler.tsx", // 'key' geçiyor ama .key uzantısı değil
    "monkey.js", // 'key' içeriyor ama .key değil
    "apiKeyValidator.ts",
    "envConfig.ts", // 'env' geçiyor ama .env değil
    "package.json",
    "tsconfig.json",
    "secretManager.ts", // 'secret' geçiyor ama secrets.json değil — kaynak
    "environment.ts",
    "database.yml",
    "public.pem.md", // .pem ORTADA, uzantı .md — kaynak/doküman
    ".env.d.ts", // env tip-deklarasyonu — KAYNAK (kod uzantısı .ts → negatif lookahead muaf)
    ".env.ts", // env doğrulama modülü — KAYNAK
    ".env.schema.json", // env şeması — KAYNAK (kod/veri uzantısı)
    ".env.config.js", // KAYNAK
  ];
  for (const f of sources) {
    it(`korur: ${f}`, () => expect(isSecretFile(f)).toBe(false));
  }
});
