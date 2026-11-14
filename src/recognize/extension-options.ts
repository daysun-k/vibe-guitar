/**
 * Recognizer options of the extension's listening-mode charts: the VGT-18 finalist (docs/recognition-
 * candidates.md "Search end"): mean of frame log-probabilities per unit and BTC averaged over the
 * log-CQT shifted by -1 and +1 semitone. Offline replay keeps its own default ({} = the original
 * recognizer); the live "인식 중" readout (Recognizer.live) does not use these options.
 */
import type { RecognizerOptions } from './recognizer';
import type { UncertaintyOptions } from './uncertainty';

export const EXTENSION_RECOGNIZER_OPTIONS: Readonly<RecognizerOptions> = Object.freeze({ emission: 'meanLog', pitchShift: [-1, 1] });

/**
 * Uncertain-section flags of the extension's charts (VGT-19, docs/uncertainty-protocol.md): the frozen
 * signal and threshold once the DEV criterion is fixed; null = no flags (charts unchanged).
 */
export const EXTENSION_UNCERTAINTY: Readonly<UncertaintyOptions> | null = null;
