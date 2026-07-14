import { describe, it, expect } from "vitest";
import { expectedPortFor } from "./intent-router/handlers/command.js";

// dev-server komutunun beklenen portu — waitForDevServer bu portu yoklar; YANLIŞSA sağlıklı server öldürülür
// (mahkeme: rackup 9292'de çalışıp 8080 yoklandığı için Ruby Faz 6 açılamıyordu). Bu testler tabloyu kilitler.
describe("expectedPortFor — profil `dev` komutlarının portları (dev-server profil bypass fix)", () => {
  it("rackup → 9292 (mahkeme bulgusu: eskiden 8080 fallback → Ruby app açılamıyordu)", () => {
    expect(expectedPortFor("bundle exec rackup")).toBe(9292);
  });
  it("deno task dev → 8000 (profil default_port ile tutarlı)", () => {
    expect(expectedPortFor("deno task dev")).toBe(8000);
  });

  it("AÇIK port bayrağı framework tahminini EZER: rackup -p 3000 → 3000", () => {
    expect(expectedPortFor("bundle exec rackup -p 3000")).toBe(3000);
  });
  it("açık --port: uvicorn --port 8080 → 8080 (default 8000 değil)", () => {
    expect(expectedPortFor("uvicorn main:app --port 8080")).toBe(8080);
  });
  it("açık -p=: vite -p=4321 → 4321", () => {
    expect(expectedPortFor("npx vite -p=4321")).toBe(4321);
  });

  // Regresyon: mevcut framework tahminleri bozulmamalı
  it.each([
    ["uvicorn main:app --reload", 8000],
    ["mix phx.server", 4000],
    ["php -S localhost:8000", 8000],
    ["bundle exec rails server", 3000],
    ["npx vite", 5173],
    ["next dev", 3000],
    ["mvn spring-boot:run", 8080],
    ["dotnet run", 5000],
    ["flask run", 5000],
    ["some-unknown-cmd", 8080], // fallback
  ])("regresyon: %s → %i", (cmd, port) => {
    expect(expectedPortFor(cmd)).toBe(port);
  });
});
