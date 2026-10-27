// Empty selection accepts every row; multiple selected codes accept any match.
// Shared by the two organizer organization lists.
export function matchesAnySelected<T>(
  codes: readonly T[],
  selected: ReadonlySet<T>
): boolean {
  return selected.size === 0 || codes.some((code) => selected.has(code))
}
