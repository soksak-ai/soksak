export type LayoutStagedTargetParticipant = Readonly<{
  id: string;
  stagedTargets: readonly string[];
}>;

/** Participant-local ownership receipts form one transaction-level target identity set. */
export function mergeLayoutStagedTargets(
  participants: readonly LayoutStagedTargetParticipant[],
): string[] {
  return [...new Set(participants.flatMap(({ stagedTargets }) => stagedTargets))];
}
