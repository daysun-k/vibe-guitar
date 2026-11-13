/** recognize/session for listen.ts in the --audio-dump build: analyzeClosedSegments records its snapshot. */
import { analyzeClosedSegments as original } from '../../recognize/session';
import { hooks } from './hooks';

export * from '../../recognize/session';
export const analyzeClosedSegments: typeof original = hooks.analyzeClosedSegments;
