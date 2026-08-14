export type NativeBrowserFrame = { x: number; y: number; width: number; height: number };

export function createNativeBrowserFramePublisher(
  apply: (sequence: number, frame: NativeBrowserFrame) => void,
) {
  let sequence = 0;
  return {
    publish(frame: NativeBrowserFrame) {
      sequence += 1;
      apply(sequence, frame);
      return sequence;
    },
  };
}
