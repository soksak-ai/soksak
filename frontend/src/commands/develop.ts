// Development record writes — plugin_develop / sidecar_develop. One environment revision step each
// (writeEnvironmentRevision). The host validates the path (absolute and clean); the frontend passes it through.
import { writeEnvironmentRevision } from "../state/environmentEvents";

export function writeDevelopRecord(
  command: "plugin_develop" | "sidecar_develop",
  args: { id: string; path: string },
): Promise<{ revision: number }> {
  return writeEnvironmentRevision(command, args);
}
