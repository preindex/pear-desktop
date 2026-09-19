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
  silenceAwareTransitions: boolean;
};

export type CrossfadeAudioFormat = 'webm' | 'mp4' | 'ogg' | 'mp3';

type CrossfadeAudioAnalysis = {
  audibleStart: number;
  audibleEnd: number;
  duration: number;
};

type CrossfadeBufferedAudio = {
  dataUrl: string;
  format: CrossfadeAudioFormat;
  analysis?: CrossfadeAudioAnalysis;
  analysisAttempted?: boolean;
};

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
    /**
     * Detect audible track boundaries so fades are not spent on encoded
     * leading or trailing silence.
     *
     * @default false
     */
    silenceAwareTransitions: false,
  },
  async menu({ window, getConfig, setConfig }) {
    const promptCrossfadeValues = async (
      win: BrowserWindow,
      options: CrossfadePluginConfig,
    ): Promise<
      | Omit<CrossfadePluginConfig, 'enabled' | 'silenceAwareTransitions'>
      | undefined
    > => {
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

    const config = await getConfig();

    return [
      {
        label: 'Silence-aware transitions',
        type: 'checkbox',
        checked: config.silenceAwareTransitions,
        click(item: Electron.MenuItem) {
          setConfig({ silenceAwareTransitions: item.checked });
        },
      },
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

      const MIRROR_RETRY_DELAY_MS = 5000;
      const MIRROR_START_TIMEOUT_MS = 750;
      const SILENCE_THRESHOLD_DB = -55;
      const SILENCE_WINDOW_MS = 20;
      const SILENCE_MIN_AUDIBLE_MS = 80;
      const SILENCE_PREROLL_MS = 75;
      const MAX_BUFFERED_TRACKS = 2;

      let transitionAudio: Howl | undefined;
      let transitionAudioVideoID: string | undefined;
      let currentVideoID: string | undefined;
      let preparingVideoID: string | undefined;
      let preparationGeneration = 0;
      let retryTimeout: number | undefined;
      let startingMirrorVideoID: string | undefined;
      let transitionTriggeredVideoID: string | undefined;
      let thresholdLoggedVideoID: string | undefined;
      let incomingFadePending = false;
      let incomingFadeVideoID: string | undefined;
      let incomingFadeAt: number | undefined;
      let incomingVolume = video.volume;
      let mirrorStartTimeout: number | undefined;
      let checkForCrossfade: (elapsed?: number) => void = () => undefined;

      const bufferedAudioCache = new Map<string, CrossfadeBufferedAudio>();
      const bufferedAudioPromises = new Map<
        string,
        Promise<CrossfadeBufferedAudio | undefined>
      >();
      const audioAnalysisByVideoID = new Map<string, CrossfadeAudioAnalysis>();

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

      const analyzeBufferedAudio = async (
        bufferedAudio: CrossfadeBufferedAudio,
        videoID: string,
      ): Promise<CrossfadeAudioAnalysis | undefined> => {
        if (bufferedAudio.analysisAttempted) {
          return bufferedAudio.analysis;
        }
        bufferedAudio.analysisAttempted = true;

        try {
          const encoded = await fetch(bufferedAudio.dataUrl).then((response) =>
            response.arrayBuffer(),
          );
          const decoder = new OfflineAudioContext(1, 1, 44100);
          const decoded = await decoder.decodeAudioData(encoded);
          const windowFrames = Math.max(
            1,
            Math.round((decoded.sampleRate * SILENCE_WINDOW_MS) / 1000),
          );
          const requiredWindows = Math.max(
            1,
            Math.ceil(SILENCE_MIN_AUDIBLE_MS / SILENCE_WINDOW_MS),
          );
          const audiblePowerThreshold = 10 ** (SILENCE_THRESHOLD_DB / 10);

          const isWindowAudible = (start: number, end: number) => {
            let power = 0;
            let samples = 0;

            for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
              const channelData = decoded.getChannelData(channel);
              for (let frame = start; frame < end; frame++) {
                const sample = channelData[frame];
                power += sample * sample;
                samples += 1;
              }
            }

            return samples > 0 && power / samples >= audiblePowerThreshold;
          };

          let audibleStartFrame: number | undefined;
          let consecutiveAudibleWindows = 0;

          for (
            let start = 0;
            start < decoded.length;
            start += windowFrames
          ) {
            const end = Math.min(decoded.length, start + windowFrames);
            if (isWindowAudible(start, end)) {
              consecutiveAudibleWindows += 1;
              if (consecutiveAudibleWindows >= requiredWindows) {
                audibleStartFrame = Math.max(
                  0,
                  start - (requiredWindows - 1) * windowFrames,
                );
                break;
              }
            } else {
              consecutiveAudibleWindows = 0;
            }
          }

          let audibleEndFrame: number | undefined;
          let latestAudibleWindowEnd: number | undefined;
          consecutiveAudibleWindows = 0;

          for (let end = decoded.length; end > 0; end -= windowFrames) {
            const start = Math.max(0, end - windowFrames);
            if (isWindowAudible(start, end)) {
              if (consecutiveAudibleWindows === 0) {
                latestAudibleWindowEnd = end;
              }
              consecutiveAudibleWindows += 1;
              if (consecutiveAudibleWindows >= requiredWindows) {
                audibleEndFrame = latestAudibleWindowEnd;
                break;
              }
            } else {
              consecutiveAudibleWindows = 0;
              latestAudibleWindowEnd = undefined;
            }
          }

          if (
            audibleStartFrame === undefined ||
            audibleEndFrame === undefined ||
            audibleStartFrame >= audibleEndFrame
          ) {
            return undefined;
          }

          const prerollSeconds = SILENCE_PREROLL_MS / 1000;
          const analysis = {
            audibleStart: Math.max(
              0,
              audibleStartFrame / decoded.sampleRate - prerollSeconds,
            ),
            audibleEnd: Math.min(
              decoded.duration,
              audibleEndFrame / decoded.sampleRate + prerollSeconds,
            ),
            duration: decoded.duration,
          } satisfies CrossfadeAudioAnalysis;

          bufferedAudio.analysis = analysis;
          audioAnalysisByVideoID.set(videoID, analysis);
          console.info('[crossfade] Audio boundaries detected', {
            videoID,
            ...analysis,
          });
          return analysis;
        } catch (error) {
          console.warn('[crossfade] Audio boundary analysis failed', {
            videoID,
            error,
          });
          return undefined;
        }
      };

      const trimBufferedAudioCache = () => {
        while (bufferedAudioCache.size > MAX_BUFFERED_TRACKS) {
          const oldestVideoID = bufferedAudioCache.keys().next().value as
            | string
            | undefined;
          if (!oldestVideoID) {
            break;
          }
          bufferedAudioCache.delete(oldestVideoID);
        }
      };

      const getBufferedAudio = async (
        videoID: string,
      ): Promise<CrossfadeBufferedAudio | undefined> => {
        const cached = bufferedAudioCache.get(videoID);
        if (cached) {
          if (this.config?.silenceAwareTransitions) {
            await analyzeBufferedAudio(cached, videoID);
          }
          return cached;
        }

        const pending = bufferedAudioPromises.get(videoID);
        if (pending) {
          return pending;
        }

        const request = (async () => {
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

            const bufferedAudio: CrossfadeBufferedAudio = {
              dataUrl: response,
              format,
            };
            bufferedAudioCache.set(videoID, bufferedAudio);
            trimBufferedAudioCache();

            if (this.config?.silenceAwareTransitions) {
              await analyzeBufferedAudio(bufferedAudio, videoID);
            }

            return bufferedAudio;
          } catch (error) {
            console.error('[crossfade] Failed to get buffered audio', error);
            return undefined;
          } finally {
            bufferedAudioPromises.delete(videoID);
          }
        })();

        bufferedAudioPromises.set(videoID, request);
        return request;
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

      const getVideoIDFromURL = () => {
        try {
          const url = api.getVideoUrl();
          return url
            ? (new URL(url).searchParams.get('v') ?? undefined)
            : undefined;
        } catch {
          return undefined;
        }
      };

      const getPlaylistVideoID = () => {
        try {
          const playlist = api.getPlaylist<string[]>();
          const index = api.getPlaylistIndex();
          const videoID = playlist?.[index];

          return typeof videoID === 'string' && videoID.length > 0
            ? videoID
            : undefined;
        } catch {
          return undefined;
        }
      };

      const getNextPlaylistVideoID = () => {
        try {
          const playlist = api.getPlaylist<string[]>();
          const index = api.getPlaylistIndex();
          const videoID = playlist?.[index + 1];

          return typeof videoID === 'string' && videoID.length > 0
            ? videoID
            : undefined;
        } catch {
          return undefined;
        }
      };

      const getActiveVideoID = () =>
        getVideoIDFromURL() ??
        getPlaylistVideoID() ??
        api.getVideoData().video_id;

      const isPlaybackActive = () =>
        !video.paused && !video.ended && !video.seeking;

      const isMirrorReady = (videoID = currentVideoID) =>
        transitionAudioVideoID === videoID &&
        transitionAudio?.state() === 'loaded';

      const mapAnalysisTimeToPlayer = (
        analysisTime: number,
        analysis: CrossfadeAudioAnalysis,
        playerDuration: number,
      ) =>
        analysis.duration > 0 && Number.isFinite(playerDuration)
          ? analysisTime * (playerDuration / analysis.duration)
          : analysisTime;

      const clearRetry = () => {
        if (retryTimeout !== undefined) {
          window.clearTimeout(retryTimeout);
          retryTimeout = undefined;
        }
      };

      const clearMirrorStartTimeout = () => {
        if (mirrorStartTimeout !== undefined) {
          window.clearTimeout(mirrorStartTimeout);
          mirrorStartTimeout = undefined;
        }
      };

      const prefetchNextTrack = async () => {
        if (!this.config?.silenceAwareTransitions) {
          return;
        }

        const nextVideoID = getNextPlaylistVideoID();
        if (!nextVideoID || nextVideoID === currentVideoID) {
          return;
        }

        await getBufferedAudio(nextVideoID);
      };

      const scheduleRetry = (videoID: string) => {
        if (
          retryTimeout !== undefined ||
          currentVideoID !== videoID ||
          isMirrorReady(videoID)
        ) {
          return;
        }

        console.warn('[crossfade] Scheduling mirror retry', {
          videoID,
          delay: MIRROR_RETRY_DELAY_MS,
        });

        retryTimeout = window.setTimeout(() => {
          retryTimeout = undefined;
          if (currentVideoID === videoID && !isMirrorReady(videoID)) {
            void prepareMirror(videoID);
          }
        }, MIRROR_RETRY_DELAY_MS);
      };

      const prepareMirror = async (videoID: string) => {
        if (
          !videoID ||
          currentVideoID !== videoID ||
          preparingVideoID === videoID ||
          isMirrorReady(videoID)
        ) {
          return;
        }

        clearRetry();
        const generation = ++preparationGeneration;
        preparingVideoID = videoID;
        const bufferedAudio = await getBufferedAudio(videoID);

        if (
          generation !== preparationGeneration ||
          currentVideoID !== videoID
        ) {
          return;
        }

        if (!bufferedAudio) {
          preparingVideoID = undefined;
          scheduleRetry(videoID);
          return;
        }

        if (bufferedAudio.analysis) {
          audioAnalysisByVideoID.set(videoID, bufferedAudio.analysis);
        }

        const audio = new Howl({
          src: [bufferedAudio.dataUrl],
          format: [bufferedAudio.format],
          html5: false,
          preload: true,
          volume: 0,
          onload: () => {
            if (
              generation !== preparationGeneration ||
              currentVideoID !== videoID
            ) {
              audio.unload();
              return;
            }

            preparingVideoID = undefined;
            transitionAudio?.unload();
            transitionAudio = audio;
            transitionAudioVideoID = videoID;
            bufferedAudioCache.delete(videoID);
            clearRetry();
            console.info('[crossfade] Transition audio ready', videoID);
            checkForCrossfade();
            void prefetchNextTrack();
          },
          onloaderror: (_id, error) => {
            if (
              generation === preparationGeneration &&
              currentVideoID === videoID
            ) {
              preparingVideoID = undefined;
              scheduleRetry(videoID);
            }
            console.error(
              '[crossfade] Failed to load transition audio',
              bufferedAudio.format,
              error,
            );
          },
        });
      };

      const ensureMirrorPreparation = () => {
        if (
          currentVideoID &&
          !isMirrorReady(currentVideoID) &&
          preparingVideoID !== currentVideoID &&
          retryTimeout === undefined
        ) {
          void prepareMirror(currentVideoID);
        }
      };

      const fadeVideoIn = (targetVolume: number) => {
        const duration = this.config?.fadeInDuration ?? 0;

        if (duration <= 0) {
          video.volume = targetVolume;
          return;
        }

        video.volume = 0;
        new VolumeFader(video, {
          fadeScaling: this.config?.fadeScaling,
          fadeDuration: duration,
        }).fadeTo(targetVolume);
      };

      const clearIncomingFadeBoundary = () => {
        incomingFadeVideoID = undefined;
        incomingFadeAt = undefined;
      };

      const startIncomingFade = (
        activeVideoID: string,
        elapsed = getProgressValue(),
      ) => {
        if (!incomingFadePending) {
          return;
        }

        incomingFadePending = false;
        clearIncomingFadeBoundary();

        if (!this.config?.silenceAwareTransitions) {
          fadeVideoIn(incomingVolume);
          return;
        }

        const analysis =
          audioAnalysisByVideoID.get(activeVideoID) ??
          bufferedAudioCache.get(activeVideoID)?.analysis;
        const playerDuration = getDuration();

        if (!analysis || !Number.isFinite(playerDuration) || playerDuration <= 0) {
          fadeVideoIn(incomingVolume);
          return;
        }

        const audibleStart = mapAnalysisTimeToPlayer(
          analysis.audibleStart,
          analysis,
          playerDuration,
        );

        if (!Number.isFinite(audibleStart) || elapsed >= audibleStart) {
          fadeVideoIn(incomingVolume);
          return;
        }

        incomingFadeVideoID = activeVideoID;
        incomingFadeAt = audibleStart;
        video.volume = 0;
        console.info('[crossfade] Waiting for incoming audible start', {
          videoID: activeVideoID,
          audibleStart,
        });
      };

      const checkIncomingFade = (elapsed = getProgressValue()) => {
        if (
          !incomingFadeVideoID ||
          incomingFadeVideoID !== currentVideoID ||
          incomingFadeAt === undefined
        ) {
          return;
        }

        if (!this.config?.silenceAwareTransitions) {
          clearIncomingFadeBoundary();
          fadeVideoIn(incomingVolume);
          return;
        }

        if (
          Number.isFinite(elapsed) &&
          elapsed >= incomingFadeAt &&
          isPlaybackActive()
        ) {
          const videoID = incomingFadeVideoID;
          clearIncomingFadeBoundary();
          console.info('[crossfade] Incoming audible start reached', {
            videoID,
            currentTime: elapsed,
          });
          fadeVideoIn(incomingVolume);
        }
      };

      const getVolumeScale = () => {
        const scaling = this.config?.fadeScaling;
        if (scaling === 'linear') {
          return {
            toInternal: (level: number) => level,
            fromInternal: (level: number) => level,
          };
        }

        const dynamicRange =
          typeof scaling === 'number' && scaling > 0
            ? scaling / 20
            : 3;

        return {
          toInternal: (level: number) =>
            level === 0
              ? 0
              : Math.max(1 + (Math.log10(level) / dynamicRange), 0),
          fromInternal: (level: number) =>
            level === 0 ? 0 : 10 ** ((level - 1) * dynamicRange),
        };
      };

      const fadeMirrorOut = (
        audio: Howl,
        soundID: number,
        startVolume: number,
      ) => {
        const duration = this.config?.fadeOutDuration ?? 0;
        if (duration <= 0) {
          audio.volume(0, soundID);
          audio.stop(soundID);
          audio.unload();
          return;
        }

        const scale = getVolumeScale();
        const startLevel = scale.toInternal(startVolume);
        const startedAt = performance.now();

        const update = (now: number) => {
          const progress = Math.min((now - startedAt) / duration, 1);
          const level = startLevel * (1 - progress);
          audio.volume(scale.fromInternal(level), soundID);

          if (progress < 1) {
            window.requestAnimationFrame(update);
            return;
          }

          audio.stop(soundID);
          audio.unload();
          console.info('[crossfade] Outgoing fade complete');
        };

        window.requestAnimationFrame(update);
      };

      const abortMirrorStart = (
        audio: Howl,
        videoID: string,
        reason: unknown,
      ) => {
        clearMirrorStartTimeout();
        if (transitionAudio === audio) {
          transitionAudio = undefined;
          transitionAudioVideoID = undefined;
        }
        startingMirrorVideoID = undefined;
        audio.stop();
        audio.unload();
        console.warn('[crossfade] Mirror start aborted', { videoID, reason });
        scheduleRetry(videoID);
      };

      const beginCrossfade = () => {
        if (
          !currentVideoID ||
          !transitionAudio ||
          !isMirrorReady(currentVideoID) ||
          startingMirrorVideoID ||
          transitionTriggeredVideoID === currentVideoID ||
          !isPlaybackActive()
        ) {
          return;
        }

        const outgoingVideoID = currentVideoID;
        const outgoingAudio = transitionAudio;
        const position = video.currentTime;
        const startVolume = video.volume;
        let settled = false;

        startingMirrorVideoID = outgoingVideoID;
        outgoingAudio.seek(position);
        // Start the mirror silently. Only expose it after Howler confirms
        // playback and we have re-synced it to the live media clock.
        outgoingAudio.volume(0);

        const removeListeners = () => {
          outgoingAudio.off('play', onPlay);
          outgoingAudio.off('playerror', onPlayError);
        };

        const onPlay = (soundID: number) => {
          if (settled) {
            return;
          }

          if (
            currentVideoID !== outgoingVideoID ||
            !isPlaybackActive()
          ) {
            settled = true;
            removeListeners();
            abortMirrorStart(
              outgoingAudio,
              outgoingVideoID,
              'active track changed before handoff',
            );
            return;
          }

          settled = true;
          removeListeners();
          clearMirrorStartTimeout();
          startingMirrorVideoID = undefined;
          transitionTriggeredVideoID = outgoingVideoID;
          transitionAudio = undefined;
          transitionAudioVideoID = undefined;
          incomingVolume = startVolume;
          incomingFadePending = true;

          // The mirror may have taken a few milliseconds to begin. Re-sync
          // while it is still silent, then atomically hand audible output over
          // from YouTube Music to the mirror.
          const handoffPosition = video.currentTime;
          outgoingAudio.seek(handoffPosition, soundID);
          video.volume = 0;
          outgoingAudio.volume(startVolume, soundID);
          fadeMirrorOut(outgoingAudio, soundID, startVolume);

          console.info('[crossfade] Outgoing mirror confirmed', {
            videoID: outgoingVideoID,
            position: handoffPosition,
          });
          api.nextVideo();
        };

        const onPlayError = (_soundID: number, error: unknown) => {
          if (settled) {
            return;
          }
          settled = true;
          removeListeners();
          abortMirrorStart(outgoingAudio, outgoingVideoID, error);
        };

        outgoingAudio.once('play', onPlay);
        outgoingAudio.once('playerror', onPlayError);
        mirrorStartTimeout = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            removeListeners();
            abortMirrorStart(
              outgoingAudio,
              outgoingVideoID,
              'mirror start timeout',
            );
          }
        }, MIRROR_START_TIMEOUT_MS);

        try {
          outgoingAudio.play();
        } catch (error) {
          onPlayError(0, error);
        }
      };

      const handleActiveTrack = (activeVideoID = getActiveVideoID()) => {
        if (!activeVideoID || activeVideoID === currentVideoID) {
          return;
        }

        const previousVideoID = currentVideoID;
        currentVideoID = activeVideoID;
        preparationGeneration += 1;
        preparingVideoID = undefined;
        clearRetry();
        clearMirrorStartTimeout();
        startingMirrorVideoID = undefined;
        transitionTriggeredVideoID = undefined;
        thresholdLoggedVideoID = undefined;
        clearIncomingFadeBoundary();

        if (previousVideoID) {
          audioAnalysisByVideoID.delete(previousVideoID);
        }

        if (
          transitionAudio &&
          transitionAudioVideoID !== activeVideoID
        ) {
          transitionAudio.unload();
          transitionAudio = undefined;
          transitionAudioVideoID = undefined;
        }

        console.info('[crossfade] Active track changed', {
          from: previousVideoID,
          to: activeVideoID,
        });

        if (incomingFadePending) {
          startIncomingFade(activeVideoID);
        }

        void prepareMirror(activeVideoID);
      };

      checkForCrossfade = (elapsed?: number) => {
        const progressValue = elapsed ?? getProgressValue();
        checkIncomingFade(progressValue);

        const duration = getDuration();
        const analysis =
          this.config?.silenceAwareTransitions && currentVideoID
            ? audioAnalysisByVideoID.get(currentVideoID)
            : undefined;
        const effectiveEnd = analysis
          ? Math.min(
              duration,
              mapAnalysisTimeToPlayer(analysis.audibleEnd, analysis, duration),
            )
          : duration;
        const threshold =
          effectiveEnd - (this.config?.secondsBeforeEnd ?? 0);

        if (
          !currentVideoID ||
          !Number.isFinite(progressValue) ||
          !Number.isFinite(duration) ||
          duration <= 0
        ) {
          return;
        }

        if (progressValue < threshold) {
          if (thresholdLoggedVideoID === currentVideoID) {
            thresholdLoggedVideoID = undefined;
          }

          if (
            transitionTriggeredVideoID === currentVideoID &&
            !incomingFadePending &&
            !startingMirrorVideoID
          ) {
            transitionTriggeredVideoID = undefined;
            console.info('[crossfade] Transition re-armed', currentVideoID);
            ensureMirrorPreparation();
          }
          return;
        }

        if (!isPlaybackActive()) {
          return;
        }

        if (thresholdLoggedVideoID !== currentVideoID) {
          thresholdLoggedVideoID = currentVideoID;
          console.info('[crossfade] Crossfade threshold reached', {
            videoID: currentVideoID,
            currentTime: progressValue,
            duration,
            effectiveEnd,
            silenceAware: Boolean(analysis),
            mirrorReady: isMirrorReady(),
          });
        }

        if (!isMirrorReady()) {
          // Fail open: without a mirror, leave YouTube Music completely alone.
          ensureMirrorPreparation();
          return;
        }

        beginCrossfade();
      };

      currentVideoID = getActiveVideoID();
      if (currentVideoID) {
        void prepareMirror(currentVideoID);
      }

      video.addEventListener('playing', () => {
        // During `playing`, getVideoData() corresponds to the media that
        // actually started. URL/playlist state can lag briefly when going back.
        handleActiveTrack(api.getVideoData().video_id || getActiveVideoID());
        ensureMirrorPreparation();
        checkForCrossfade();
      });

      video.addEventListener('play', () => {
        ensureMirrorPreparation();
        checkForCrossfade();
      });

      video.addEventListener('seeked', () => {
        ensureMirrorPreparation();
        checkForCrossfade();
      });

      if (progressBar) {
        const observer = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            const target = mutation.target as HTMLElement & { value: string };
            checkForCrossfade(Number(target.value));
          }
        });

        observer.observe(progressBar, {
          attributes: true,
          attributeFilter: ['value'],
        });
      } else {
        video.addEventListener('timeupdate', () => checkForCrossfade());
      }
    },
  },
});