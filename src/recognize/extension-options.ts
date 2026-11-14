/**
 * Recognizer options of the extension's listening-mode charts: the VGT-18 finalist (docs/recognition-
 * candidates.md "Search end"): mean of frame log-probabilities per unit and BTC averaged over the
 * log-CQT shifted by -1 and +1 semitone. Offline replay keeps its own default ({} = the original
 * recognizer); the live "인식 중" readout (Recognizer.live) does not use these options.
 */
import type { RecognizerOptions } from './recognizer';
import type { UncertaintyOptions } from './uncertainty';
import { UNCERTAINTY_CRITERION } from './uncertainty-criterion';

export const EXTENSION_RECOGNIZER_OPTIONS: Readonly<RecognizerOptions> = Object.freeze({ emission: 'meanLog', pitchShift: [-1, 1] });

/**
 * Uncertain-section flags of the extension's charts (VGT-19, docs/uncertainty-protocol.md "Amendment 1"):
 * the frozen DEV criterion, flag tier below `threshold`, replace tier below `replaceBelow`.
 */
export const EXTENSION_UNCERTAINTY: Readonly<UncertaintyOptions> | null = Object.freeze({
  signal: UNCERTAINTY_CRITERION.signal,
  threshold: UNCERTAINTY_CRITERION.threshold,
  replaceBelow: UNCERTAINTY_CRITERION.replaceBelow,
});
