/** recognize/autochart for listen.ts in the --audio-dump build: buildAutoChart posts the analysed audio. */
import { hooks } from './hooks';

export * from '../../recognize/autochart';
export const buildAutoChart = hooks.buildAutoChart;
