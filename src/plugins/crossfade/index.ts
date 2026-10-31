import prompt from 'custom-electron-prompt';
import { Howl } from 'howler';

import { t } from '@/i18n';
import { getRepeatMode } from '@/providers/player-ui';
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
        label: t('plugins.crossfade.menu.silence-aware'),
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
    async onPlayerApiReady() {
      const separateAudioGraphPlugins = [
        'custom-output-device',
        'equalizer',
        'audio-compressor',
        'exponential-volume',
      ];
      const enabledAudioGraphPlugins = await Promise.all(
        separateAudioGraphPlugins.map(async (plugin) =>
          (await window.mainConfig.plugins.isEnabled(plugin))
            ? plugin
            : undefined,
        ),
      );
      const conflictingPlugins = enabledAudioGraphPlugins.filter(
        (plugin): plugin is string => plugin !== undefined,
      );
      if (conflictingPlugins.length > 0) {
        console.warn(
          '[crossfade] Keeping native playback because these plugins use a separate audio graph:',
          conflictingPlugins,
        );
        return;
      }

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
      const MAX_MIRROR_RETRIES = 3;
      const MIRROR_START_TIMEOUT_MS = 750;
      const SILENCE_THRESHOLD_DB = -55;
      const SILENCE_WINDOW_MS = 20;
      const SILENCE_MIN_AUDIBLE_MS = 80;
      const SILENCE_PREROLL_MS = 75;
      const MAX_BUFFERED_TRACKS = 2;
      const MAX_ANALYSIS_AUDIO_BYTES = 8 * 1024 * 1024;

      let transitionAudio: Howl | undefined;
      let transitionAudioVideoID: string | undefined;
      let currentVideoID: string | undefined;
      let preparingVideoID: string | undefined;
      let preparationGeneration = 0;
      let retryTimeout: number | undefined;
      let mirrorRetryAttempts = 0;
      let startingMirrorVideoID: string | undefined;
      let transitionTriggeredVideoID: string | undefined;
      let thresholdLoggedVideoID: string | undefined;
      let incomingFadePending = false;
      let incomingFadeVideoID: string | undefined;
      let incomingFadeAt: number | undefined;
      let incomingVolume = video.volume;
      let mirrorStartTimeout: number | undefined;
      let handoffTimeout: number | undefined;
      let incomingFader: VolumeFader | undefined;
      let lastIncomingFaderVolume: number | undefined;
      let handoffRequested = false;
      let activeOutgoing:
        | {
            audio: Howl;
            soundID: number;
            cancelFade: () => void;
            videoID: string;
            expectedVideoID?: string;
          }
        | undefined;
      let checkForCrossfade: (elapsed?: number) => void = () => undefined;
      let suppressVolumeChangeUntil = 0;

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

        const base64Start = bufferedAudio.dataUrl.indexOf(',') + 1;
        const encodedBytes = Math.floor(
          ((bufferedAudio.dataUrl.length - base64Start) * 3) / 4,
        );
        if (encodedBytes > MAX_ANALYSIS_AUDIO_BYTES) {
          console.info(
            '[crossfade] Skipping silence analysis for large audio',
            {
              videoID,
              encodedBytes,
            },
          );
          return undefined;
        }

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

            for (
              let channel = 0;
              channel < decoded.numberOfChannels;
              channel++
            ) {
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

          for (let start = 0; start < decoded.length; start += windowFrames) {
            const end = Math.min(decoded.length, start + windowFrames);
            if (isWindowAudible(start, end)) {
              consecutiveAudibleWindows += 1;
              if (consecutiveAudibleWindows >= requiredWindows) {
                const leadingAudibleFrames =
                  (requiredWindows - 1) * windowFrames;
                audibleStartFrame = Math.max(0, start - leadingAudibleFrames);
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
          const audibleStartSeconds = audibleStartFrame / decoded.sampleRate;
          const audibleEndSeconds = audibleEndFrame / decoded.sampleRate;
          const analysis = {
            audibleStart: Math.max(0, audibleStartSeconds - prerollSeconds),
            audibleEnd: Math.min(
              decoded.duration,
              audibleEndSeconds + prerollSeconds,
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
          const oldestVideoID = bufferedAudioCache.keys().next().value;
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
            const response: unknown = await this.ipc?.invoke(
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

      const getProgressValue = () => video.currentTime;

      const getDuration = () => {
        const mediaDuration = video.duration;
        return Number.isFinite(mediaDuration) && mediaDuration > 0
          ? mediaDuration
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

      const clearHandoffTimeout = () => {
        if (handoffTimeout !== undefined) {
          window.clearTimeout(handoffTimeout);
          handoffTimeout = undefined;
        }
      };

      const stopIncomingFader = () => {
        incomingFader?.stop();
        incomingFader = undefined;
        lastIncomingFaderVolume = undefined;
      };

      const stopActiveOutgoing = () => {
        const outgoing = activeOutgoing;
        activeOutgoing = undefined;
        if (!outgoing) return;
        outgoing.cancelFade();
        outgoing.audio.stop(outgoing.soundID);
        outgoing.audio.unload();
      };

      const restoreIncomingVolume = () => {
        clearHandoffTimeout();
        stopIncomingFader();
        incomingFadePending = false;
        clearIncomingFadeBoundary();
        suppressVolumeChangeUntil = performance.now() + 100;
        video.volume = incomingVolume;
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

        if (mirrorRetryAttempts >= MAX_MIRROR_RETRIES) {
          console.warn('[crossfade] Mirror retries exhausted', { videoID });
          return;
        }

        const backoffMultiplier = 2 ** mirrorRetryAttempts;
        const delay = MIRROR_RETRY_DELAY_MS * backoffMultiplier;
        mirrorRetryAttempts += 1;

        console.warn('[crossfade] Scheduling mirror retry', {
          videoID,
          delay,
        });

        retryTimeout = window.setTimeout(() => {
          retryTimeout = undefined;
          if (currentVideoID === videoID && !isMirrorReady(videoID)) {
            prepareMirror(videoID).catch(console.error);
          }
        }, delay);
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
            mirrorRetryAttempts = 0;
            bufferedAudioCache.delete(videoID);
            clearRetry();
            console.info('[crossfade] Transition audio ready', videoID);
            checkForCrossfade();
            prefetchNextTrack().catch(console.error);
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
          prepareMirror(currentVideoID).catch(console.error);
        }
      };

      const fadeVideoIn = (targetVolume: number) => {
        stopIncomingFader();
        const duration = this.config?.fadeInDuration ?? 0;

        if (duration <= 0) {
          suppressVolumeChangeUntil = performance.now() + 100;
          video.volume = targetVolume;
          incomingVolume = targetVolume;
          return;
        }

        suppressVolumeChangeUntil = performance.now() + 100;
        lastIncomingFaderVolume = 0;
        video.volume = 0;
        const fader = new VolumeFader(video, {
          fadeScaling: this.config?.fadeScaling,
          fadeDuration: duration,
          onUpdate: (volume) => {
            lastIncomingFaderVolume = volume;
          },
        });
        incomingFader = fader;
        fader.fadeTo(targetVolume, () => {
          if (incomingFader === fader) {
            incomingFader = undefined;
            incomingVolume = targetVolume;
          }
        });
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

        if (
          !analysis ||
          !Number.isFinite(playerDuration) ||
          playerDuration <= 0
        ) {
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
        suppressVolumeChangeUntil = performance.now() + 100;
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
          typeof scaling === 'number' && scaling > 0 ? scaling / 20 : 3;

        return {
          toInternal: (level: number) => {
            if (level === 0) return 0;
            const logarithmicLevel = Math.log10(level) / dynamicRange;
            return Math.max(1 + logarithmicLevel, 0);
          },
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
          return () => undefined;
        }

        const scale = getVolumeScale();
        const startLevel = scale.toInternal(startVolume);
        const startedAt = performance.now();

        let timer: number | undefined;
        const finish = () => {
          if (timer !== undefined) {
            window.clearInterval(timer);
            timer = undefined;
          }
          audio.stop(soundID);
          audio.unload();
          if (activeOutgoing?.audio === audio) {
            activeOutgoing = undefined;
          }
          console.info('[crossfade] Outgoing fade complete');
        };

        const update = () => {
          if (audio.state() !== 'loaded') {
            finish();
            return;
          }
          const now = performance.now();
          const progress = Math.min((now - startedAt) / duration, 1);
          const level = startLevel * (1 - progress);
          audio.volume(scale.fromInternal(level), soundID);

          if (progress >= 1) {
            finish();
          }
        };

        timer = window.setInterval(update, 16);
        update();
        return () => {
          if (timer !== undefined) {
            window.clearInterval(timer);
            timer = undefined;
          }
        };
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
          !isPlaybackActive() ||
          video.muted ||
          api.isMuted() ||
          video.volume <= 0 ||
          getRepeatMode() === 'ONE'
        ) {
          return;
        }

        const duration = getDuration();
        const analysis = this.config?.silenceAwareTransitions
          ? audioAnalysisByVideoID.get(currentVideoID)
          : undefined;
        const effectiveEnd = analysis
          ? Math.min(
              duration,
              mapAnalysisTimeToPlayer(analysis.audibleEnd, analysis, duration),
            )
          : duration;
        if (
          effectiveEnd > 0 &&
          effectiveEnd <= (this.config?.secondsBeforeEnd ?? 0)
        ) {
          // Keep very short tracks on the native player instead of skipping
          // them as soon as their mirror finishes loading.
          return;
        }

        const outgoingVideoID = currentVideoID;
        const outgoingAudio = transitionAudio;
        const position = video.currentTime;
        const startVolume = incomingFader ? incomingVolume : video.volume;
        let settled = false;

        startingMirrorVideoID = outgoingVideoID;
        outgoingAudio.seek(position);
        outgoingAudio.rate(video.playbackRate);
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

          if (currentVideoID !== outgoingVideoID || !isPlaybackActive()) {
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
          stopIncomingFader();
          incomingVolume = startVolume;
          incomingFadePending = true;

          // The mirror may have taken a few milliseconds to begin. Re-sync
          // while it is still silent, then atomically hand audible output over
          // from YouTube Music to the mirror.
          const handoffPosition = video.currentTime;
          outgoingAudio.seek(handoffPosition, soundID);
          suppressVolumeChangeUntil = performance.now() + 100;
          video.volume = 0;
          outgoingAudio.volume(startVolume, soundID);
          const cancelFade = fadeMirrorOut(outgoingAudio, soundID, startVolume);
          const expectedVideoID = getNextPlaylistVideoID();
          activeOutgoing = {
            audio: outgoingAudio,
            soundID,
            cancelFade,
            videoID: outgoingVideoID,
            expectedVideoID,
          };

          console.info('[crossfade] Outgoing mirror confirmed', {
            videoID: outgoingVideoID,
            position: handoffPosition,
          });
          handoffRequested = true;
          clearHandoffTimeout();
          handoffTimeout = window.setTimeout(() => {
            handoffTimeout = undefined;
            if (incomingFadePending) {
              handoffRequested = false;
              console.warn('[crossfade] Handoff did not start a new track', {
                videoID: outgoingVideoID,
              });
              restoreIncomingVolume();
              stopActiveOutgoing();
            }
          }, 3000);
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

      const handleActiveTrack = (
        activeVideoID = getActiveVideoID(),
        force = false,
      ) => {
        if (!activeVideoID || (!force && activeVideoID === currentVideoID)) {
          return;
        }

        const previousVideoID = currentVideoID;
        const wasHandoffRequested = handoffRequested;
        handoffRequested = false;
        if (incomingFadeVideoID || incomingFadeAt !== undefined) {
          // A manual skip while waiting for the audible start must not leave
          // the newly selected track muted.
          suppressVolumeChangeUntil = performance.now() + 100;
          video.volume = incomingVolume;
        }
        if (activeOutgoing) {
          if (!activeOutgoing.expectedVideoID && wasHandoffRequested) {
            activeOutgoing.expectedVideoID = activeVideoID;
          } else if (activeVideoID !== activeOutgoing.expectedVideoID) {
            stopActiveOutgoing();
          }
        }
        clearHandoffTimeout();
        currentVideoID = activeVideoID;
        mirrorRetryAttempts = 0;
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

        if (transitionAudio && transitionAudioVideoID !== activeVideoID) {
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

        prepareMirror(activeVideoID).catch(console.error);
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
        const threshold = effectiveEnd - (this.config?.secondsBeforeEnd ?? 0);

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
        prepareMirror(currentVideoID).catch(console.error);
      }

      video.addEventListener('playing', () => {
        // During `playing`, getVideoData() corresponds to the media that
        // actually started. URL/playlist state can lag briefly when going back.
        const activeVideoID = api.getVideoData().video_id || getActiveVideoID();
        // A queue repeat can hand off to the same video ID. The pending fade
        // marks this playing event as a new playback instance in that case.
        handleActiveTrack(activeVideoID, incomingFadePending);
        handoffRequested = false;
        if (incomingFadePending && activeVideoID) {
          // Queue repeats may reuse the same video ID, so the active ID alone
          // cannot prove that the handoff failed.
          clearHandoffTimeout();
          startIncomingFade(activeVideoID);
        }
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

      video.addEventListener('pause', () => {
        if (handoffRequested) return;
        if (activeOutgoing) {
          stopActiveOutgoing();
        }
        if (incomingFader || incomingFadePending || incomingFadeVideoID) {
          restoreIncomingVolume();
        }
      });

      video.addEventListener('seeking', () => {
        if (handoffRequested) return;
        if (activeOutgoing) {
          stopActiveOutgoing();
        }
        if (incomingFader || incomingFadePending || incomingFadeVideoID) {
          restoreIncomingVolume();
        }
      });

      video.addEventListener('volumechange', () => {
        const isIncomingFadeVolumeChange =
          lastIncomingFaderVolume !== undefined &&
          Math.abs(video.volume - lastIncomingFaderVolume) <= 0.001;

        if (video.muted || api.isMuted()) {
          // Never let a mirror bypass an explicit mute action.
          stopActiveOutgoing();
          if (incomingFadePending || incomingFadeVideoID) {
            restoreIncomingVolume();
          }
        } else if (handoffRequested) {
          if (video.volume > 0) {
            incomingVolume = video.volume;
          }
          suppressVolumeChangeUntil = performance.now() + 100;
          video.volume = 0;
        } else if (
          incomingFader &&
          lastIncomingFaderVolume !== undefined &&
          Math.abs(video.volume - lastIncomingFaderVolume) > 0.001
        ) {
          // Respect volume changes made while the incoming song is fading in.
          stopIncomingFader();
          incomingVolume = video.volume;
          if (incomingFadePending || incomingFadeVideoID) {
            restoreIncomingVolume();
          }
        } else if (
          performance.now() > suppressVolumeChangeUntil &&
          !incomingFader &&
          !incomingFadePending &&
          !incomingFadeVideoID
        ) {
          incomingVolume = video.volume;
        }
        if (
          activeOutgoing &&
          !isIncomingFadeVolumeChange &&
          performance.now() > suppressVolumeChangeUntil
        ) {
          // End the mirror overlap on a user volume adjustment; the player's
          // volume remains authoritative and the new value cannot be replaced
          // by a stale fade envelope.
          stopActiveOutgoing();
          incomingVolume = video.volume;
          if (incomingFadePending || incomingFadeVideoID) {
            restoreIncomingVolume();
          }
        }
        if (!video.muted && performance.now() > suppressVolumeChangeUntil) {
          checkForCrossfade();
        }
      });

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          checkForCrossfade();
        }
      });

      if (progressBar) {
        const observer = new MutationObserver(() => checkForCrossfade());

        observer.observe(progressBar, {
          attributes: true,
          attributeFilter: ['value'],
        });
      }
      video.addEventListener('timeupdate', () => checkForCrossfade());
    },
  },
});
