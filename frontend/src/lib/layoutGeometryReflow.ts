import { useLayoutEffect } from "react";
import { emitPluginEvent } from "../plugins/hooks";

export function useLayoutGeometryReflow(signature: string, activeSpaceId: string | null): void {
  useLayoutEffect(() => {
    emitPluginEvent("layout.reflow", { activeSpaceId });
  }, [signature, activeSpaceId]);
}
