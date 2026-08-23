import type { RegistryPublicKey } from "./spec";

// Official registry trust root. The signing private key is release infrastructure only;
// the application embeds the public half and accepts no runtime override.
export const OFFICIAL_REGISTRY_TRUST: RegistryPublicKey = {
  algorithm: "ed25519",
  keyId: "c20999a2363b111b542847cfe55ccf83",
  value: "1+sauDCNHW7nZNKvPXb8mJ362wTQFrr3xjUhnnTYJGg=",
};
