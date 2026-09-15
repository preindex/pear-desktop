import { Innertube } from 'youtubei.js';

import { getNetFetchAsFetch } from '@/plugins/utils/main';

import type { BackendContext } from '@/types/contexts';
import type {
  CrossfadeAudioFormat,
  CrossfadePluginConfig,
} from './index';

export const backend = async ({
  ipc,
}: BackendContext<CrossfadePluginConfig>) => {
  const netFetch = getNetFetchAsFetch();
  const ytPromise = Innertube.create({
    fetch: netFetch,
  });

  const streamingClients = [
    'ANDROID_VR',
    'TV',
    'WEB_EMBEDDED',
  ] as const;

  const getHowlerFormat = (
    mimeType?: string,
  ): CrossfadeAudioFormat | undefined => {
    const mime = mimeType?.toLowerCase();

    if (mime?.includes('audio/webm')) return 'webm';
    if (mime?.includes('audio/mp4')) return 'mp4';
    if (mime?.includes('audio/ogg')) return 'ogg';
    if (mime?.includes('audio/mpeg')) return 'mp3';

    return undefined;
  };

  const getBaseMimeType = (
    mimeType: string | null | undefined,
    format: CrossfadeAudioFormat,
  ) => {
    const mime = mimeType?.split(';')[0]?.trim().toLowerCase();

    if (mime?.startsWith('audio/')) {
      return mime;
    }

    switch (format) {
      case 'webm':
        return 'audio/webm';
      case 'mp4':
        return 'audio/mp4';
      case 'ogg':
        return 'audio/ogg';
      case 'mp3':
        return 'audio/mpeg';
    }
  };

  ipc.handle('crossfade-audio-data-v1', async (videoID: string) => {
    const failures: string[] = [];
    const yt = await ytPromise;

    for (const client of streamingClients) {
      try {
        const stream = await yt.getStreamingData(videoID, {
          client,
          type: 'audio',
          quality: 'best',
          format: 'any',
        });

        const howlerFormat = getHowlerFormat(stream.mime_type);

        if (!stream.url || !howlerFormat) {
          failures.push(
            `${client}: ${stream.url ? `unsupported MIME ${stream.mime_type ?? 'unknown'}` : 'no URL'}`,
          );
          continue;
        }

        const response = await netFetch(stream.url);
        if (!response.ok) {
          failures.push(`${client}: media fetch HTTP ${response.status}`);
          continue;
        }

        const audioBuffer = await response.arrayBuffer();
        if (audioBuffer.byteLength === 0) {
          failures.push(`${client}: empty media response`);
          continue;
        }

        const mimeType = getBaseMimeType(
          stream.mime_type ?? response.headers.get('content-type'),
          howlerFormat,
        );
        const { Buffer } = await import('node:buffer');
        const dataUrl = `data:${mimeType};base64,${Buffer.from(audioBuffer).toString('base64')}`;

        console.info(
          `[crossfade] Buffered ${client} ${mimeType} audio for ${videoID} (${audioBuffer.byteLength} bytes)`,
        );

        return dataUrl;
      } catch (error) {
        failures.push(
          `${client}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    throw new Error(
      `No usable buffered audio for ${videoID} (${failures.join('; ')})`,
    );
  });
};
