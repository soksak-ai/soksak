import { nativeSurfaceDOMRuntime, startNativeSurfaceObserver } from "@soksak/wails-service-native-compositor";
import type { NativeSurfaceCommit } from "@soksak/wails-service-native-compositor";

import * as CompositorService from "../../../bindings/github.com/soksak/wails-service-native-compositor/service";
import { Snapshot } from "../../../bindings/github.com/soksak/wails-service-native-compositor/models";

const commit: NativeSurfaceCommit = async (snapshot) => {
  const receipt = await CompositorService.Commit(Snapshot.createFrom(snapshot));
  // Publish the applied inventory on the document, so the composition check reads this one receipt instead
  // of recomputing the geometry from a second source.
  document.documentElement.dataset.nativeSnapshotSequence = String(receipt.sequence);
  document.documentElement.dataset.nativeSnapshotAccepted = String(receipt.accepted);
  document.documentElement.dataset.nativeSnapshotCount = String(receipt.surfaces.length);
  return receipt;
};

let controller: { stop(): void } | null = null;

export function startNativeSurfaces(root: Document = document): void {
  controller?.stop();
  controller = startNativeSurfaceObserver(nativeSurfaceDOMRuntime(root), commit);
}

/** Clears the native child inventory in one transaction. Only the next full DOM snapshot can show them again. */
export async function suspendNativeSurfaces(): Promise<void> {
  controller?.stop();
  controller = null;
}
