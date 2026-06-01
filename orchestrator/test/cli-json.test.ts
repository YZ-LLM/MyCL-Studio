// cli-json — string-aware JSON çıkarımı (saf fonksiyon, mock yok).

import { describe, expect, it } from "vitest";
import {
  scanBalancedObjects,
  extractLastJsonObject,
  extractKindBlock,
} from "../src/cli-json.js";

describe("scanBalancedObjects", () => {
  it("top-level dengeli nesneleri bulur (nested + string-içi parantez)", () => {
    const t = `önce {"a":1} sonra {"b":{"c":2},"s":"şu { değil }"} son`;
    const out = scanBalancedObjects(t);
    expect(out).toEqual([`{"a":1}`, `{"b":{"c":2},"s":"şu { değil }"}`]);
  });
  it("kaçışlı tırnağı doğru yönetir", () => {
    const t = `{"s":"a \\" { b"}`;
    expect(scanBalancedObjects(t)).toEqual([`{"s":"a \\" { b"}`]);
  });
  it("nesne yoksa boş", () => {
    expect(scanBalancedObjects("hiç yok")).toEqual([]);
  });
});

describe("extractLastJsonObject", () => {
  it("predicate'i sağlayan SON nesneyi alır", () => {
    const t = `{"action":"chat","reason":"ilk"} ara {"action":"run_phase","reason":"son"}`;
    expect(extractLastJsonObject(t, (o) => "action" in o)).toEqual({
      action: "run_phase",
      reason: "son",
    });
  });
  it("```json fence içindeki nesneyi de yakalar (regex yok)", () => {
    const t = "metin\n```json\n{\"action\":\"chat\",\"reason\":\"x\"}\n```";
    expect(extractLastJsonObject(t, (o) => "action" in o)).toEqual({
      action: "chat",
      reason: "x",
    });
  });
  it("predicate sağlanmazsa null", () => {
    expect(extractLastJsonObject(`{"foo":1}`, (o) => "action" in o)).toBeNull();
  });
  it("bozuk JSON → null", () => {
    expect(extractLastJsonObject(`{"action":"chat",}`, (o) => "action" in o)).toBeNull();
  });
});

describe("extractKindBlock", () => {
  it("kind alanı eşleşen son bloğu alır", () => {
    const t = `{"kind":"askq","question_en":"a"} sonra {"kind":"complete","x":1}`;
    expect(extractKindBlock(t, ["askq", "complete"])).toEqual({ kind: "complete", x: 1 });
  });
  it("askq bloğu (terminal kind sonrasında soru) — sonuncu kazanır", () => {
    const t = `{"kind":"complete"} {"kind":"askq","question_en":"q"}`;
    expect(extractKindBlock(t, ["askq", "complete"])).toEqual({
      kind: "askq",
      question_en: "q",
    });
  });
  it("eşleşen kind yoksa null", () => {
    expect(extractKindBlock(`{"kind":"other"}`, ["askq", "complete"])).toBeNull();
  });
});
