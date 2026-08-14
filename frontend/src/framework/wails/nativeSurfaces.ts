// The framework half of native child surfaces.
//
// The core declares surfaces in the DOM and never learns how they are composed.
// Where content lives inside the document instead, this becomes a no-op and the
// core is unchanged.
import { nativeSurfaceDOMRuntime, startNativeSurfaceObserver } from "@soksak/wails-service-native-compositor";
import type { NativeSurfaceCommit } from "@soksak/wails-service-native-compositor";

import * as CompositorService from "../../../bindings/github.com/soksak/wails-service-native-compositor/service";
import { Snapshot } from "../../../bindings/github.com/soksak/wails-service-native-compositor/models";

const commit: NativeSurfaceCommit = async (snapshot) => {
  const receipt = await CompositorService.Commit(Snapshot.createFrom(snapshot));
  // The applied inventory is published on the document so a compositing verdict
  // reads one receipt rather than recomputing geometry from a second source.
  document.documentElement.dataset.nativeSnapshotSequence = String(receipt.sequence);
  document.documentElement.dataset.nativeSnapshotAccepted = String(receipt.accepted);
  document.documentElement.dataset.nativeSnapshotCount = String(receipt.surfaces.length);
  return receipt;
};

/** Begin observing declared surfaces. Returns a stopper. */
export function startNativeSurfaces(root: Document = document): () => void {
  const controller = startNativeSurfaceObserver(nativeSurfaceDOMRuntime(root), commit);
  return () => controller.stop();
}
