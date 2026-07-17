import path from "node:path";
import { fileURLToPath } from "node:url";

// ESM'de __dirname eşdeğeri — workspace-root'u sabitlemek için.
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // MyCL hedef-proje DIŞINDA başka lockfile'lar görebildiği için "multiple lockfiles"
  // uyarısı basılır; workspace-root'u bu projeye sabitleyerek build'i temizler.
  outputFileTracingRoot: __dirname,
  // Güvenlik header'ları tüm rotalara uygulanır (HSTS / clickjacking / MIME-sniff /
  // referrer sızıntısı / tarayıcı yetenek erişimi).
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
