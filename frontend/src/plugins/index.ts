// The application's registries. One of each, because a second registry is a
// second answer to "what exists" and the two drift silently.
import { createCommandRegistry } from "./commands";
import { createProgramRegistry } from "./programs";
import { createViewRegistry } from "./views";

export const views = createViewRegistry();
export const programs = createProgramRegistry();
export const commands = createCommandRegistry();

export type { CommandDefinition, CommandOwner, CommandTable } from "./commands";
export type { ProgramDescriptor } from "./programs";
export type { ViewContext, ViewHandle, ViewProvider } from "./views";
