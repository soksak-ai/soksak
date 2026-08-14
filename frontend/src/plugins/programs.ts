// A program is something a pane can become.
//
// The add menu is a projection of this list and nothing else. The core routes
// by an opaque id: it never enumerates the programs that exist, so a program it
// has never heard of works the same as one shipped with it.

export interface ProgramDescriptor {
  readonly id: string;
  /** Shown in the add menu. The plugin owns its own wording. */
  readonly title: string;
  /** The view this program renders through. */
  readonly viewId: string;
}

export interface ProgramRegistry {
  register(program: ProgramDescriptor): void;
  unregister(id: string): void;
  resolve(id: string): ProgramDescriptor | null;
  /** Registration order. Sorting here would be the core ranking plugins. */
  list(): ProgramDescriptor[];
}

export function createProgramRegistry(): ProgramRegistry {
  const programs = new Map<string, ProgramDescriptor>();

  return {
    register(program) {
      if (!program.id) throw new Error("program id is required");
      // A program without a view is a menu entry that opens nothing. Failing
      // here names the gap; failing at mount time would only show an empty pane.
      if (!program.viewId) throw new Error(`program ${program.id} declares no viewId`);
      programs.set(program.id, { ...program });
    },
    unregister(id) {
      programs.delete(id);
    },
    resolve(id) {
      const program = programs.get(id);
      return program ? { ...program } : null;
    },
    list() {
      return [...programs.values()].map((program) => ({ ...program }));
    },
  };
}
