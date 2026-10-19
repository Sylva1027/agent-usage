import { PALETTE_TOKEN_KEYS } from "../../public/skins.js";
import { buildSkinBootstrapSource } from "./bootstrap-source.mjs";
import { SKIN_IDS } from "./contracts.mjs";
import { resolveProductionSelection } from "./review-production.mjs";

const MODES = Object.freeze(["light", "dark"]);

/** Build the canonical full bootstrap bytes for the ten explicitly selected palettes. */
export function buildProductionBootstrapSource({ verifiedModel, selections } = {}) {
  const overrides = {};
  for (const skinId of SKIN_IDS) {
    const candidateId = selections?.choices?.[skinId]?.candidateId;
    const { candidate } = resolveProductionSelection({ verifiedModel, selections, candidateId });
    if (candidate.skinId !== skinId) throw new TypeError(`selection for ${skinId} resolved to ${candidate.skinId}`);

    overrides[skinId] = Object.fromEntries(
      MODES.map((mode) => [
        mode,
        Object.fromEntries(PALETTE_TOKEN_KEYS.map((token) => [token, candidate.modes[mode][token]])),
      ]),
    );
  }
  return Buffer.from(buildSkinBootstrapSource(overrides), "utf8");
}
