// Single source of the consent screen display data — PluginConsentModal (visual) and plugin.consent.summary
// (data, idempotence check) derive from the same function. Zero prose — extracted mechanically from the
// manifest declaration.
//
// Permissions and contributions are manifest values directly; dependencies are plugin↔plugin (dependencies)
// plus external libraries (libraries, collected transitively). Listing library and plugin deps is the core of
// this function (dependencies on the consent screen = rule).

import type { LibraryDep, LocalizedText, PluginManifest, ReleaseReference } from "./spec";
import { runtimePluginRequirements, runtimeSidecarReferences } from "./runtimeDependencies";
import { transitiveLibraries, type PluginRuntime } from "../state/plugins";
import { activationChain, type DepNode } from "./dependencyGraph";

// Dependency plugin entry — exact required and installed versions plus permissions. A dependency can hold strong
// permissions (process and the like), so the consent screen must show them (honest disclosure §0-2 — the user
// consents to dependencies too, no half consent).
export interface DepPluginSummary {
  id: string;
  requiredVersion?: string;
  name?: LocalizedText;
  installedVersion?: string;
  permissions?: string[]; // Permissions of the installed dependency (unknown while it is not installed — consent follows install)
  transitive?: boolean; // Transitive dependency, not a direct one
}

// Exposed DOM node — the consent screen lists "elements this plugin exposes outward (address click, measurement)" (honest disclosure).
export interface ExposedNodeSummary {
  id: string;
  description?: LocalizedText;
  danger?: true;
}

export interface ConsentSummary {
  id: string;
  version: string;
  permissions: string[];
  contributes: {
    views: number;
    commands: number;
    programs: number;
    iconSets: number;
  };
  // Kinds of exposed DOM node (manifest contributes.nodes) — the user sees what is clickable from outside before consenting.
  exposedNodes: ExposedNodeSummary[];
  // Dangerous commands (manifest contributes.commands.danger) — discloses what is destructive or injecting at install/consent time.
  dangerousCommands: { name: string; danger: "destructive" | "inject" }[];
  dependencies: {
    plugins: DepPluginSummary[];
    libraries: LibraryDep[];
    sidecars: ReleaseReference[];
  };
}

// Collects the permissions of the dependencies in the activation chain (dependencies first, self last),
// excluding self. So the consent screen shows permissions down to transitive dependencies — consenting to
// studio also discloses the permissions of core (and its dependencies) and takes one consent.
function dependencyConsents(
  manifest: PluginManifest,
  installed: Record<string, PluginRuntime>,
): DepPluginSummary[] {
  const nodes: DepNode[] = Object.values(installed).map((p) => ({
    id: p.manifest.id,
    version: p.manifest.version,
    dependencies: runtimePluginRequirements(p.manifest),
  }));
  // When self is not installed yet (pre-install preview), add it as a temporary node so the chain resolves.
  if (!installed[manifest.id]) {
    nodes.push({
      id: manifest.id,
      version: manifest.version,
      dependencies: runtimePluginRequirements(manifest),
    });
  }
  const directRange = runtimePluginRequirements(manifest);
  // Installed transitive deps (chain, dependencies first) + uninstalled direct deps (the chain skips uninstalled, so they are appended after).
  const ordered = activationChain(manifest.id, nodes).filter((id) => id !== manifest.id);
  for (const id of Object.keys(directRange)) {
    if (!ordered.includes(id)) ordered.push(id);
  }
  return ordered.map((id) => {
    const dep = installed[id];
    const requiredVersion = directRange[id];
    return {
      id,
      ...(requiredVersion ? { requiredVersion } : { transitive: true }),
      ...(dep
        ? {
            name: dep.manifest.name,
            installedVersion: dep.manifest.version,
            permissions: [...dep.manifest.permissions],
          }
        : {}),
    };
  });
}

export function consentSummary(
  manifest: PluginManifest,
  installed: Record<string, PluginRuntime>,
): ConsentSummary {
  const c = manifest.contributes;
  return {
    id: manifest.id,
    version: manifest.version,
    permissions: [...manifest.permissions],
    contributes: {
      views: c.views.length,
      commands: c.commands.length,
      programs: c.programs.length,
      iconSets: c.iconSets.length,
    },
    exposedNodes: c.nodes.map((n) => ({
      id: n.id,
      ...(n.description !== undefined ? { description: n.description } : {}),
      ...(n.danger ? { danger: true as const } : {}),
    })),
    dangerousCommands: c.commands
      .filter((cmd): cmd is typeof cmd & { danger: "destructive" | "inject" } =>
        cmd.danger !== undefined,
      )
      .map((cmd) => ({ name: cmd.name, danger: cmd.danger })),
    dependencies: {
      plugins: dependencyConsents(manifest, installed),
      libraries: transitiveLibraries(manifest, installed),
      sidecars: [...runtimeSidecarReferences(manifest)],
    },
  };
}
