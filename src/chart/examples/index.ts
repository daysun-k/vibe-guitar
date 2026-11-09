import type { Chart } from '../types';
import abPop from './example-ab-pop.json';
import waltz from './example-waltz-slash.json';

/** Bundled example charts. Their timings are fake (provenance.example = true). */
export const EXAMPLE_CHARTS: Chart[] = [abPop as Chart, waltz as Chart];
