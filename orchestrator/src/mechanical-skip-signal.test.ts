import { describe, it, expect } from "vitest";
import { specSignalMatches } from "./mechanical-skip-signal.js";

// SAHTE-YEŞİL-KRİTİK: bu regex bir mekanik gate'i (Faz 5 UI / DAST / perf / db) yanlış atlatırsa boş-build sahte-geçer
// (project_faz5_skip_false_green). Eskiden bu mantık index.ts'te gömülüydü + test bir KOPYAYI test ediyordu (gölge-test).
// Bu testler GERÇEK regex'i (tek kaynak) kilitler.
describe("specSignalMatches — mekanik faz spec-sinyali (gerçek regex, gölge-test değil)", () => {
  it("always / undefined → her zaman true (koşulsuz koş)", () => {
    expect(specSignalMatches("anything", "always")).toBe(true);
    expect(specSignalMatches("anything", undefined)).toBe(true);
    expect(specSignalMatches("", "always")).toBe(true);
  });

  describe("has_ui (Faz 5 UI build — yanlış SKIP = boş-build sahte-yeşil)", () => {
    it.each([
      "build a react dashboard with charts",
      "kullanıcı arayüzü: giriş sayfası ve panel",
      "add a vue component for the layout",
      "svelte frontend with a button",
    ])("UI spec → true: %s", (s) => expect(specSignalMatches(s.toLowerCase(), "has_ui")).toBe(true));

    it.each([
      "a command-line tool that parses csv files",
      "python library for matrix math",
      "background worker that processes a queue",
    ])("UI-olmayan spec → false: %s", (s) => expect(specSignalMatches(s.toLowerCase(), "has_ui")).toBe(false));

    it("'web' KELİMESİ has_ui'yi TETİKLEMEZ (mahkeme: library'de 'web browsers' → yanlış UI): 'supports web browsers' → false", () => {
      expect(specSignalMatches("a library that supports web browsers and environments", "has_ui")).toBe(false);
    });
    it("misclassified-api-with-dashboard: 'rest api with an admin dashboard' → true (pozitif override)", () => {
      expect(specSignalMatches("a rest api with an admin dashboard", "has_ui")).toBe(true);
    });
  });

  describe("has_web_target (DAST sızma testi — HTTP sunan proje)", () => {
    it.each([
      "a rest api with endpoints",
      "express server exposing http routes",
      "fastapi backend with graphql",
      "react web frontend",
    ])("HTTP-sunan → true: %s", (s) => expect(specSignalMatches(s.toLowerCase(), "has_web_target")).toBe(true));

    it.each([
      "a command-line calculator",
      "pure math library, no network",
    ])("HTTP-suymayan → false: %s", (s) => expect(specSignalMatches(s.toLowerCase(), "has_web_target")).toBe(false));
  });

  describe("has_nfr (performans gate)", () => {
    it("perf terimi → true: 'must handle 1000 rps with p99 latency' ", () =>
      expect(specSignalMatches("must handle 1000 rps with p99 latency under load", "has_nfr")).toBe(true));
    it("perf-yok → false: 'display a list of users'", () =>
      expect(specSignalMatches("display a list of users", "has_nfr")).toBe(false));
  });

  describe("has_database (db gate — NoSQL/ORM dahil)", () => {
    it.each([
      "store users in postgres via prisma",
      "mongodb collection for sessions",
      "redis cache with persistence",
      "veritabanı: kullanıcı tablosu",
    ])("db spec → true: %s", (s) => expect(specSignalMatches(s.toLowerCase(), "has_database")).toBe(true));

    it("db-yok → false: 'a stateless string formatter'", () =>
      expect(specSignalMatches("a stateless string formatter", "has_database")).toBe(false));
  });

  it("bilinmeyen koşul → true (fail-open, kuşkuda gate'i koş — sessiz-skip sahte-yeşil önleme)", () => {
    // @ts-expect-error — kasıtlı geçersiz değer (runtime fail-open davranışı testi)
    expect(specSignalMatches("anything", "has_unknown_condition")).toBe(true);
  });
});
