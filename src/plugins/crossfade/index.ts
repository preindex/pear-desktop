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

type CrossfadeState =
  | 'idle'
  | 'starting-mirror'
  | 'crossfading'
  | 'fallback-fading'
  | 'waiting-incoming';

type CrossfadePlayer = Element &
  MusicPlayer & {
    __pearCrossfadeInitialized?: boolean;
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
              label: t('plugins.crossfade.prompt.options.multi-input.fade-scaling.label'),
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
      const api = document.querySelector<CrossfadePlayer>('#movie_player');
      const video = api?.querySelector<HTMLVideoElement>('video');
      const progressBar = document.querySelector<
        HTMLElement & { value: string; max?: string }
      >('#progress-bar');

      if (!api || !video) {
        console.error('[crossfade] Player API or video element is unavailable');
        return;
      }

      if (api.__pearCrossfadeInitialized) {
        return;
      }
      api.__pearCrossfadeInitialized = true;

      let transitionAudio: Howl | undefined;
      let transitionAudioVideoID: string | undefined;
      let preparingVideoID: string | undefined;
      let currentVideoID = api.getVideoData().video_id;
      let transitionTriggeredForVideoID: string | undefined;
      let thresholdLoggedForVideoID: string | undefined;
      let incomingFadeVideoID: string | undefined;
      let incomingVolume = video.volume;
      let mirrorGeneration = 0;
      let state: CrossfadeState = 'idle';
      let mirrorStartTimeout: number | undefined;
      let checkForCrossfade: (elapsed?: number) => void = () => undefined;

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

      const getDuration = () => {
        const progressMax = Number(
          progressBar?.max ?? progressBar?.getAttribute('max'),
        );

        return Number.isFinite(progressMax) && progressMax > 0
          ? progressMax
          : api.getDuration();
      };

      const getActiveVideoID = () => api.getVideoData().video_id;
      const isPlaybackActive = () =>
        !video.paused && !video.ended && !video.seeking;

      const isMirrorReady = (videoID = currentVideoID) =>
        transitionAudioVideoID === videoID &&
        transitionAudio?.state() === 'loaded';

      const clearMirrorStartTimeout = () => {
        if (mirrorStartTimeout !== undefined) {
          window.clearTimeout(mirrorStartTimeout);
          mirrorStartTimeout = undefined;
        }
      };

      const prepareMirror = async (videoID: string) => {
        if (
          !videoID ||
          videoID !== getActiveVideoID() ||
          preparingVideoID === videoID ||
          (transitionAudioVideoID === videoID &&
            transitionAudio?.state() !== 'unloaded')
        ) {
          return;
        }

        const generation = ++mirrorGeneration;
        preparingVideoID = videoID;
        const bufferedAudio = await getBufferedAudio(videoID);

        if (
          !bufferedAudio ||
          generation !== mirrorGeneration ||
          videoID !== getActiveVideoID()
        ) {
          if (preparingVideoID === videoID) {
            preparingVideoID = undefined;
          }
          return;
        }

        const audio = new Howl({
          src: [bufferedAudio.dataUrl],
          format: [bufferedAudio.format],
          // Use WebAudio so an already-unlocked AudioContext can start the
          // automatic transition without creating a new autoplay-gated
          // HTMLMediaElement for every song.
          html5: false,
          preload: true,
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
            preparingVideoID = undefined;
            console.info('[crossfade] Transition audio ready', videoID);
            checkForCrossfade();
          },
          onloaderror: (_id, error) => {
            if (preparingVideoID === videoID) {
              preparingVideoID = undefined;
            }
            console.error(
              '[crossfade] Failed to load transition audio',
              bufferedAudio.format,
              error,
            );
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

      const waitForIncomingTrack = (outgoingVideoID?: string) => {
        state = 'waiting-incoming';
        incomingFadeVideoID = undefined;
        video.volume = 0;

        const activeVideoID = getActiveVideoID();
        if (
          outgoingVideoID &&
          activeVideoID &&
          activeVideoID !== outgoingVideoID
        ) {
          currentVideoID = activeVideoID;
          transitionTriggeredForVideoID = undefined;
          thresholdLoggedForVideoID = undefined;
          incomingFadeVideoID = activeVideoID;

          console.info(
            '[crossfade] Incoming track already active; skipping nextVideo',
            {
              outgoingVideoID,
              incomingVideoID: activeVideoID,
            },
          );

          if (isPlaybackActive()) {
            state = 'idle';
            incomingFadeVideoID = undefined;
            fadeVideoIn(incomingVolume);
          }
          return;
        }

        api.nextVideo();
      };

      const startSequentialFade = (reason: unknown) => {
        if (
          !currentVideoID ||
          (state !== 'idle' && state !== 'starting-mirror')
        ) {
          return false;
        }

        const outgoingVideoID = currentVideoID;
        clearMirrorStartTimeout();

        if (transitionAudio) {
          transitionAudio.stop();
          transitionAudio.unload();
          transitionAudio = undefined;
          transitionAudioVideoID = undefined;
        }

        incomingVolume = video.volume;
        transitionTriggeredForVideoID = outgoingVideoID;
        state = 'fallback-fading';

        const duration = this.config?.fadeOutDuration ?? 0;
        console.warn('[crossfade] Using sequential fade', {
          reason,
          videoID: outgoingVideoID,
          currentTime: getProgressValue(),
          duration,
        });

        if (duration <= 0) {
          video.volume = 0;
          console.info('[crossfade] Sequential outgoing fade complete');
          waitForIncomingTrack(outgoingVideoID);
          return true;
        }

        new VolumeFader(video, {
          fadeScaling: this.config?.fadeScaling,
          fadeDuration: duration,
        }).fadeTo(0, () => {
          console.info('[crossfade] Sequential outgoing fade complete');
          waitForIncomingTrack(outgoingVideoID);
        });

        return true;
      };

      const fallbackToSequentialFade = (reason: unknown) =>
        startSequentialFade(reason);

      const beginCrossfade = () => {
        if (
          state !== 'idle' ||
          !isMirrorReady() ||
          !transitionAudio ||
          !currentVideoID
        ) {
          return false;
        }

        const outgoingAudio = transitionAudio;
        const outgoingVideoID = currentVideoID;
        const progressValue = getProgressValue();
        const outgoingPosition = Number.isFinite(progressValue)
          ? progressValue
          : api.getCurrentTime();
        const startVolume = video.volume;
        const fadeDuration = this.config?.fadeOutDuration ?? 0;

        incomingVolume = startVolume;
        state = 'starting-mirror';
        transitionTriggeredForVideoID = outgoingVideoID;

        outgoingAudio.seek(outgoingPosition);
        outgoingAudio.volume(startVolume);

        let settled = false;
        let soundID: number | undefined;

        const removeStartListeners = () => {
          outgoingAudio.off('play', onMirrorPlay);
          outgoingAudio.off('playerror', onMirrorPlayError);
        };

        const onMirrorPlay = (id: number) => {
          if (settled || state !== 'starting-mirror') {
            return;
          }

          settled = true;
          soundID = id;
          clearMirrorStartTimeout();
          removeStartListeners();

          transitionAudio = undefined;
          transitionAudioVideoID = undefined;
          state = 'crossfading';

          // Only mute/switch YouTube Music after the outgoing mirror has
          // definitely started. This prevents a failed mirror start from
          // turning into a hard skip.
          video.volume = 0;

          console.info('[crossfade] Outgoing mirror confirmed', {
            videoID: outgoingVideoID,
            position: outgoingPosition,
            volume: startVolume,
            duration: fadeDuration,
          });

          if (fadeDuration <= 0) {
            outgoingAudio.volume(0, soundID);
            outgoingAudio.stop(soundID);
            outgoingAudio.unload();
          } else {
            outgoingAudio.once(
              'fade',
              () => {
                console.info('[crossfade] Outgoing fade complete');
                outgoingAudio.stop(soundID);
                outgoingAudio.unload();
              },
              soundID,
            );
            outgoingAudio.fade(startVolume, 0, fadeDuration, soundID);
          }

          console.info('[crossfade] Triggering next track', outgoingVideoID);
          waitForIncomingTrack(outgoingVideoID);
        };

        const onMirrorPlayError = (_id: number, error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          removeStartListeners();
          fallbackToSequentialFade(error);
        };

        outgoingAudio.once('play', onMirrorPlay);
        outgoingAudio.once('playerror', onMirrorPlayError);

        try {
          const id = outgoingAudio.play();
          if (typeof id === 'number') {
            soundID = id;
          }
        } catch (error) {
          onMirrorPlayError(soundID ?? 0, error);
          return true;
        }

        mirrorStartTimeout = window.setTimeout(() => {
          if (!settled && state === 'starting-mirror') {
            settled = true;
            removeStartListeners();
            fallbackToSequentialFade('mirror start timeout');
          }
        }, 750);

        return true;
      };

      const startIncomingFade = () => {
        if (
          state !== 'waiting-incoming' ||
          !incomingFadeVideoID ||
          incomingFadeVideoID !== currentVideoID
        ) {
          return;
        }

        state = 'idle';
        incomingFadeVideoID = undefined;
        fadeVideoIn(incomingVolume);
      };

      const handleActiveVideoChange = () => {
        const activeVideoID = getActiveVideoID();

        if (!activeVideoID || activeVideoID === currentVideoID) {
          return;
        }

        const previousVideoID = currentVideoID;
        currentVideoID = activeVideoID;
        transitionTriggeredForVideoID = undefined;
        thresholdLoggedForVideoID = undefined;

        // A mirror for the previous active track is no longer useful unless it
        // was already detached into a live outgoing crossfade.
        if (
          transitionAudio &&
          transitionAudioVideoID &&
          transitionAudioVideoID !== activeVideoID
        ) {
          transitionAudio.unload();
          transitionAudio = undefined;
          transitionAudioVideoID = undefined;
        }
        preparingVideoID = undefined;
        mirrorGeneration += 1;

        if (state === 'waiting-incoming' || state === 'crossfading') {
          state = 'waiting-incoming';
          incomingFadeVideoID = activeVideoID;
          video.volume = 0;
        } else if (state !== 'fallback-fading' && state !== 'starting-mirror') {
          state = 'idle';
        }

        console.info('[crossfade] Active track changed', {
          from: previousVideoID,
          to: activeVideoID,
        });

        void prepareMirror(activeVideoID);
      };

      video.addEventListener('playing', () => {
        handleActiveVideoChange();
        startIncomingFade();
        checkForCrossfade();
      });

      video.addEventListener('play', () => {
        checkForCrossfade();
      });

      video.addEventListener('seeked', () => {
        checkForCrossfade();
      });

      checkForCrossfade = (elapsed?: number) => {
        handleActiveVideoChange();
        startIncomingFade();

        if (state !== 'idle') {
          return;
        }

        const progressValue = elapsed ?? getProgressValue();
        const duration = getDuration();
        const secondsBeforeEnd = this.config?.secondsBeforeEnd ?? 0;
        const threshold = duration - secondsBeforeEnd;

        if (
          !currentVideoID ||
          !Number.isFinite(progressValue) ||
          !Number.isFinite(duration) ||
          duration <= 0
        ) {
          return;
        }

        if (progressValue < threshold) {
          if (thresholdLoggedForVideoID === currentVideoID) {
            thresholdLoggedForVideoID = undefined;
          }
          return;
        }

        // Crossing the threshold while paused or while a seek is still in
        // progress should only arm/prepare the transition. Resume/seeked will
        // immediately re-evaluate once playback is actually active.
        if (!isPlaybackActive()) {
          if (!isMirrorReady()) {
            void prepareMirror(currentVideoID);
          }
          return;
        }

        if (thresholdLoggedForVideoID !== currentVideoID) {
          thresholdLoggedForVideoID = currentVideoID;
          console.info('[crossfade] Crossfade threshold reached', {
            videoID: currentVideoID,
            currentTime: progressValue,
            duration,
            secondsBeforeEnd,
            mirrorVideoID: transitionAudioVideoID,
            mirrorReady: isMirrorReady(),
            paused: video.paused,
            seeking: video.seeking,
          });
        }

        if (transitionTriggeredForVideoID === currentVideoID) {
          return;
        }

        if (!isMirrorReady()) {
          void prepareMirror(currentVideoID);
          startSequentialFade('mirror not ready while threshold active');
          return;
        }

        if (!beginCrossfade()) {
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
        if (name === 'dataloaded') {
          handleActiveVideoChange();
        }
      });

      if (currentVideoID) {
        void prepareMirror(currentVideoID);
      }
    },
  },
});