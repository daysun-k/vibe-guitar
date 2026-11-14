/**
 * VGT-19 uncertain-section criterion, frozen on DEV before any TEST or K-pop replay
 * (docs/uncertainty-protocol.md "Fixing the criterion" and "Amendment 1"; numbers in
 * docs/uncertainty-results.md). Units are flagged when the family margin S4 is below `threshold`;
 * the one-tap replacement is offered only where S4 is below `replaceBelow`. Do not tune these on
 * TEST or K-pop results.
 */
export const UNCERTAINTY_CRITERION = Object.freeze({
  signal: 'S4',
  threshold: 0.394164403405739,
  replaceBelow: -0.3143507889471948,
} as const);
