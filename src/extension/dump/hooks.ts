/** The one hook instance of the --audio-dump build (see audio-dump.ts). */
import { buildAutoChart as originalBuildAutoChart } from '../../recognize/autochart';
import { analyzeClosedSegments as originalAnalyzeClosedSegments } from '../../recognize/session';
import { createAudioDumpHooks, postToReceiver } from './audio-dump';

if (!__AUDIO_DUMP__) throw new Error('audio dump hooks bundled into a build without --audio-dump');

export const hooks = createAudioDumpHooks({ analyzeClosedSegments: originalAnalyzeClosedSegments, buildAutoChart: originalBuildAutoChart }, __AUDIO_DUMP_INFO__!, (meta, segments) => postToReceiver(meta, segments));
