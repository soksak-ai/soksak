export type SwitchFrameVerdict = {
  switchFrame: number;
  switchFrames: number;
  flickerFrames: number;
  clean: boolean;
};

export function classifySwitchFrames(frameDiffs: readonly number[], noiseFloor: number): SwitchFrameVerdict {
  const changed = frameDiffs
    .map((value, frame) => ({ value, frame }))
    .filter(({ value }) => Number.isFinite(value) && value > noiseFloor);
  const switchFrames = changed.length;
  return {
    switchFrame: changed[0]?.frame ?? -1,
    switchFrames,
    flickerFrames: Math.max(0, switchFrames - 1),
    clean: switchFrames === 1,
  };
}
