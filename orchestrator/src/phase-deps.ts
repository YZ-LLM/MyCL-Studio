// phase-deps — Phase controller bağımlılık enjeksiyon paketi (v15.1.2).
//
// Eskiden Phase controller'lar 3 ayrı argüman alıyordu:
//   constructor(state: State, config: MyclConfig, spec: PhaseSpec)
//
// v15.1.2'de tek bir `PhaseDeps` objesinde gruplandı:
//   constructor(deps: PhaseDeps)
//
// Faydaları:
//   - Test mock'lanması kolay (tek obj literal vs. 3 arg)
//   - Gelecekte bağımlılık eklemek non-breaking (yeni field eklenir)
//   - v15.2.2 multi-session'da controller-per-window instantiation hazır
//
// `types.ts`'ye konmadı çünkü `MyclConfig` import'u types.ts'ye circular
// risk ekler (config.ts → types.ts). Ayrı modül daha temiz.

import type { MyclConfig } from "./config.js";
import type { PhaseSpec, State } from "./types.js";

export interface PhaseDeps {
  state: State;
  config: MyclConfig;
  spec: PhaseSpec;
}
