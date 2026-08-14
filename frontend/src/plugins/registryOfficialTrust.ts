import type { RegistryPublicKey } from "./spec";

// Official registry trust root. The signing private key is release infrastructure only;
// the application embeds the public half and accepts no runtime override.
export const OFFICIAL_REGISTRY_TRUST: RegistryPublicKey = {
  algorithm: "ed25519",
  keyId: "906dbfa9f13a0a75b305f0bda733e681",
  value: "Um+ChvRm+9VLyTNP2jVL0zgxKzg6+8jEyEdpNwfLWVc=",
};
