import type { RegistryPublicKey } from "./spec";

// Official registry trust root. The signing private key is release infrastructure only;
// the application embeds the public half and accepts no runtime override.
export const OFFICIAL_REGISTRY_TRUST: RegistryPublicKey = {
  algorithm: "ed25519",
  keyId: "5631e86079101fd2",
  value: "0QCklKgLZ13rNAYCoyrICTVcPNfIvcCMvQ4gjYrHQ+o=",
};
