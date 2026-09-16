import prompt from 'custom-electron-prompt';
import { Howl } from 'howler';

import { t } from '@/i18n';
import promptOptions from '@/providers/prompt-options';
import { createPlugin } from '@/utils';

import { VolumeFader } from './fader';
import { backend } from './main';

import type { RendererContext } from '@/types/contexts';
import type { MusicPlayer } from '@/types/music-player';
import type { BrowserWindow } from 'electron';

export type CrossfadePluginConfig = {
  enabled: boolean;
  fadeInDuration: number;
  fadeOutDuration: number;
  secondsBeforeEnd: number;
  fadeScaling: 'linear' | 'logarithmic' | number;
};

export type CrossfadeAudioFormat = 'webm' | 'mp4' | 'ogg' | 'mp3';

type CrossfadeBufferedAudio = {
  dataUrl: string;
  format: CrossfadeAudioFormat;
};

export default createPlugin<
  unknown,
  unknown,
  {
    config?: CrossfadePluginConfig;
    ipc?: RendererContext<CrossfadePluginConfig>['ipc'];
  },
  CrossfadePluginConfig
>({
  name: () => t('plugins.crossfade.name'),
  description: () => t('plugins.crossfade.description'),
  restartNeeded: true,
  config: {
    enabled: false,
    /**
     * The duration of the fade in and fade out in milliseconds.
     *
     * @default 1500ms
     */
    fadeInDuration: 1500,
    /**
     * The duration of the fade in and fade out in milliseconds.
     *
     * @default 5000ms
     */
    fadeOutDuration: 5000,
    /**
     * The duration of the fade in and fade out in seconds.
     *
     * @default 10s
     */
    secondsBeforeEnd: 10,
    /**
     * The scaling algorithm to use for the fade.
     * (or a positive number in dB)
     *
     * @default 'linear'
     */
    fadeScaling: 'linear',
  },
  menu({ window, getConfig, setConfig }) {
    const promptCrossfadeValues = async (
      win: BrowserWindow,
      options: CrossfadePluginConfig,
    ): Promise<Omit<CrossfadePluginConfig, 'enabled'> | undefined> => {
      const res = await prompt(
        {
          title: t('plugins.crossfade.prompt.options'),
          type: 'multiInput',
          multiInputOptions: [
            {
              label: t(
                'plugins.crossfade.prompt.options.multi-input.fade-in-duration',
              ),
              value: options.fadeInDuration,
              inputAttrs: {
                type: 'number',
                required: true,
                min: '0',
                step: '100',
              },
            },
            {
              label: t(
                'plugins.crossfade.prompt.options.multi-input.fade-out-duration',
              ),
              value: options.fadeOutDuration,
              inputAttrs: {
                type: 'number',
                required: true,
                min: '0',
                step: '100',
              },
            },
            {
              label: t(
                'plugins.crossfade.prompt.options.multi-input.seconds-before-end',
              ),
              value: options.secondsBeforeEnd,
              inputAttrs: {
                type: 'number',
                required: true,
                min: '0',
              },
            },
            {
              label: t(
                'plugins.crossfade.prompt.options.multi-input.fade-scaling.label',
              ),
              selectOptions: {
                linear: t(
                  'plugins.crossfade.prompt.options.multi-input.fade-scaling.linear',
                ),
                logarithmic: t(
                  'plugins.crossfade.prompt.options.multi-input.fade-scaling.logarithmic',
                ),
              },
              value: options.fadeScaling,
            },
          ],
          resizable: true,
          height: 360,
          ...promptOptions(),
        },
        win,
      ).catch(console.error);

      if (!res) {
        return undefined;
      }

      let fadeScaling: 'linear' | 'logarithmic' | number;
      if (res[3] === 'linear' || res[3] === 'logarithmic') {
        fadeScaling = res[3];
      } else if (isFinite(Number(res[3]))) {
        fadeScaling = Number(res[3]);
      } else {
        fadeScaling = options.fadeScaling;
      }

      return {
        fadeInDuration: Number(res[0]),
        fadeOutDuration: Number(res[1]),
        secondsBeforeEnd: Number(res[2]),
        fadeScaling,
      };
    };

    return [
      {
        label: t('plugins.crossfade.menu.advanced'),
        async click() {
          const newOptions = await promptCrossfadeValues(
            window,
            await getConfig(),
          );
          if (newOptions) {
            setConfig(newOptions);
          }
        },
      },
    ];
  },

  backend,

  renderer: {
    async start({ ipc, getConfig }) {
      this.config = await getConfig();
      this.ipc = ipc;
    },
    onConfigChange(newConfig) {
      this.config = newConfig;
    },
    onPlayerApiReady() {
      const api = document.querySelector<Element & MusicPlayer>('#movie_player');
      const video = api?.querySelector<HTMLVideoElement>('video');
      const progressBar = document.querySelector<
        HTMLElement & { value: string; max?: string }
      >('#progress-bar');

      if (!api || !video) {
        console.error('[crossfade] Player API or video element is unavailable');
        return;
      }

      let transitionAudio: Howl | undefined;
      let transitionAudioVideoID: string | undefined;
      let currentVideoID = api.getVideoData().video_id;
      let transitionTriggeredForVideoID: string | undefined;
      let awaitingIncomingFade = false;
      let incomingFadeVideoID: string | undefined;
      let incomingVolume = video.volume;
      let mirrorGeneration = 0;

      const inferFormatFromDataUrl = (
        dataUrl: string,
      ): CrossfadeAudioFormat | undefined => {
        const mime = /^data:(audio\/[^;,]+)/i.exec(dataUrl)?.[1]?.toLowerCase();

        if (mime?.includes('audio/webm')) return 'webm';
        if (mime?.includes('audio/mp4')) return 'mp4';
        if (mime?.includes('audio/ogg')) return 'ogg';
        if (mime?.includes('audio/mpeg')) return 'mp3';

        return undefined;
      };

      const getBufferedAudio = async (
        videoID: string,
      ): Promise<CrossfadeBufferedAudio | undefined> => {
        try {
          const response = await this.ipc?.invoke(
            'crossfade-audio-data-v1',
            videoID,
          );

          if (
            typeof response !== 'string' ||
            !response.startsWith('data:audio/')
          ) {
            console.error(
              '[crossfade] Invalid buffered audio response',
              videoID,
              typeof response,
            );
            return undefined;
          }

          const format = inferFormatFromDataUrl(response);
          if (!format) {
            console.error(
              '[crossfade] Buffered audio has unsupported MIME type',
              videoID,
            );
            return undefined;
          }

          return {
            dataUrl: response,
            format,
          };
        } catch (error) {
          console.error('[crossfade] Failed to get buffered audio', error);
          return undefined;
        }
      };

      const getProgressValue = () =>
        Number(progressBar?.value ?? progressBar?.getAttribute('value'));

      const getActiveVideoID = () => api.getVideoData().video_id;

      const isReadyToCrossfade = (videoID = currentVideoID) =>
        transitionAudioVideoID === videoID &&
        transitionAudio?.state() === 'loaded' &&
        transitionAudio._sounds[0]?._node instanceof HTMLMediaElement;

      const syncMirrorToVideo = (audio: Howl) => {
        audio.play();

        const progressValue = getProgressValue();
        audio.seek(
          Number.isFinite(progressValue) ? progressValue : api.getCurrentTime(),
        );

        if (video.paused) {
          audio.pause();
        }
      };

      const prepareMirror = async (videoID: string) => {
        const generation = ++mirrorGeneration;
        const bufferedAudio = await getBufferedAudio(videoID);

        if (
          !bufferedAudio ||
          generation !== mirrorGeneration ||
          videoID !== getActiveVideoID()
        ) {
          return;
        }

        const audio = new Howl({
          src: [bufferedAudio.dataUrl],
          format: [bufferedAudio.format],
          html5: true,
          volume: 0,
          onload: () => {
            if (
              generation !== mirrorGeneration ||
              videoID !== getActiveVideoID()
            ) {
              audio.unload();
              return;
            }

            transitionAudio?.unload();
            transitionAudio = audio;
            transitionAudioVideoID = videoID;
            console.info('[crossfade] Buffered transition audio ready', videoID);
            syncMirrorToVideo(audio);
          },
          onloaderror: (_id, error) => {
            console.error(
              '[crossfade] Failed to load buffered transition audio',
              bufferedAudio.format,
              error,
            );
          },
          onplayerror: (_id, error) => {
            console.error('[crossfade] Failed to play transition audio', error);
          },
        });
      };

      const fadeVideoIn = (targetVolume: number) => {
        const duration = this.config?.fadeInDuration ?? 0;

        if (duration <= 0) {
          video.volume = targetVolume;
          console.info('[crossfade] Incoming audio restored immediately');
          return;
        }

        video.volume = 0;
        console.info('[crossfade] Incoming fade started', {
          targetVolume,
          duration,
        });

        new VolumeFader(video, {
          fadeScaling: this.config?.fadeScaling,
          fadeDuration: duration,
        }).fadeTo(targetVolume, () => {
          console.info('[crossfade] Incoming fade complete');
        });
      };

      const beginOutgoingFade = () => {
        if (!isReadyToCrossfade() || !transitionAudio) {
          return false;
        }

        const outgoingAudio = transitionAudio;
        const progressValue = getProgressValue();
        const outgoingPosition = Number.isFinite(progressValue)
          ? progressValue
          : api.getCurrentTime();

        outgoingAudio.seek(outgoingPosition);
        if (!outgoingAudio.playing()) {
          outgoingAudio.play();
        }

        incomingVolume = video.volume;
        awaitingIncomingFade = true;
        incomingFadeVideoID = undefined;
        transitionAudio = undefined;
        transitionAudioVideoID = undefined;

        // Hand the audible signal from YouTube Music to the synchronized mirror.
        // Use Howler's own volume state instead of changing its private media node.
        outgoingAudio.volume(incomingVolume);
        video.volume = 0;

        const duration = this.config?.fadeOutDuration ?? 0;
        console.info('[crossfade] Outgoing fade started', {
          position: outgoingPosition,
          volume: incomingVolume,
          duration,
        });

        if (duration <= 0) {
          outgoingAudio.volume(0);
          outgoingAudio.unload();
          return true;
        }

        outgoingAudio.once('fade', () => {
          console.info('[crossfade] Outgoing fade complete');
          outgoingAudio.unload();
        });
        outgoingAudio.fade(incomingVolume, 0, duration);

        return true;
      };

      const startIncomingFade = () => {
        if (
          !awaitingIncomingFade ||
          !incomingFadeVideoID ||
          incomingFadeVideoID !== currentVideoID
        ) {
          return;
        }

        awaitingIncomingFade = false;
        incomingFadeVideoID = undefined;
        fadeVideoIn(incomingVolume);
      };

      const handleActiveVideoChange = () => {
        const activeVideoID = getActiveVideoID();

        if (!activeVideoID || activeVideoID === currentVideoID) {
          return;
        }

        const previousVideoID = currentVideoID;

        if (!awaitingIncomingFade && isReadyToCrossfade(previousVideoID)) {
          beginOutgoingFade();
        }

        currentVideoID = activeVideoID;
        transitionTriggeredForVideoID = undefined;

        if (awaitingIncomingFade) {
          incomingFadeVideoID = activeVideoID;
          // Keep the new track silent until playback has actually started.
          video.volume = 0;
        }

        console.info('[crossfade] Active track changed', {
          from: previousVideoID,
          to: activeVideoID,
        });

        void prepareMirror(activeVideoID);
      };

      video.addEventListener('seeking', () => {
        if (isReadyToCrossfade() && transitionAudio) {
          const progressValue = getProgressValue();
          transitionAudio.seek(
            Number.isFinite(progressValue) ? progressValue : api.getCurrentTime(),
          );
        }
      });

      video.addEventListener('pause', () => {
        transitionAudio?.pause();
      });

      video.addEventListener('play', () => {
        if (isReadyToCrossfade() && transitionAudio) {
          syncMirrorToVideo(transitionAudio);
        }
      });

      video.addEventListener('playing', () => {
        startIncomingFade();
      });

      const checkForCrossfade = (elapsed?: number) => {
        handleActiveVideoChange();

        // A progress update proves the new track's media clock has started.
        // This is a reliable fallback if Chromium does not emit a fresh
        // `playing` event when YouTube Music swaps sources on the same element.
        startIncomingFade();

        const progressValue = elapsed ?? getProgressValue();
        const progressMax = Number(
          progressBar?.max ?? progressBar?.getAttribute('max'),
        );
        const duration = Number.isFinite(progressMax) && progressMax > 0
          ? progressMax
          : api.getDuration();
        const secondsBeforeEnd = this.config?.secondsBeforeEnd ?? 0;

        if (
          !currentVideoID ||
          transitionTriggeredForVideoID === currentVideoID ||
          !Number.isFinite(progressValue) ||
          !Number.isFinite(duration) ||
          duration <= 0 ||
          progressValue < duration - secondsBeforeEnd
        ) {
          return;
        }

        console.info('[crossfade] Crossfade threshold reached', {
          videoID: currentVideoID,
          currentTime: progressValue,
          duration,
          secondsBeforeEnd,
          mirrorVideoID: transitionAudioVideoID,
          mirrorReady: isReadyToCrossfade(),
        });

        if (!isReadyToCrossfade()) {
          return;
        }

        transitionTriggeredForVideoID = currentVideoID;

        if (beginOutgoingFade()) {
          console.info('[crossfade] Triggering transition', currentVideoID);
          api.nextVideo();
        } else {
          transitionTriggeredForVideoID = undefined;
        }
      };

      if (progressBar) {
        const progressObserver = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            const target = mutation.target as HTMLElement & { value: string };
            checkForCrossfade(Number(target.value));
          }
        });

        progressObserver.observe(progressBar, {
          attributes: true,
          attributeFilter: ['value'],
        });
        checkForCrossfade();
      } else {
        console.error('[crossfade] Progress bar is unavailable');
      }

      api.addEventListener('videodatachange', (name) => {
        if (name !== 'dataloaded') {
          return;
        }

        // YouTube Music can emit dataloaded for a queued/preloaded track before
        // it becomes the active player item. Always resolve identity from the
        // player API rather than trusting the event payload.
        handleActiveVideoChange();
      });

      if (currentVideoID) {
        void prepareMirror(currentVideoID);
      }
    },
  },
});
