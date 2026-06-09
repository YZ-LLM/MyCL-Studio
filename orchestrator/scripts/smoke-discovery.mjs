// Canlı smoke: model-discovery web-araması GERÇEK config + gerçek backend (cli/api) ile çalışıyor mu?
// Read-only (WebSearch server-tarafı). dist'ten import (check derledi).
import { tmpdir } from "node:os";
import { loadConfig, backendForRole } from "../dist/config.js";
import { discoverModelsViaWeb } from "../dist/model-discovery.js";
import { setLiveTiersFromModels } from "../dist/model-catalog.js";

const config = await loadConfig();
console.log("main backend:", backendForRole(config, "main"));
console.log("Keşif başlıyor (web arama, ~30-60sn)...\n");
const t0 = Date.now();
const models = await discoverModelsViaWeb(config, tmpdir());
console.log(`\nSüre: ${Math.round((Date.now() - t0) / 1000)}sn — bulunan model: ${models.length}`);
for (const m of models) {
  console.log(`  - ${m.id} | ${m.display_name}${m.tier ? ` (LLM dök-tier: ${m.tier})` : ""}`);
}
const tiers = setLiveTiersFromModels(models);
console.log("\nTier ataması (deterministik aile + LLM):", JSON.stringify(tiers));
