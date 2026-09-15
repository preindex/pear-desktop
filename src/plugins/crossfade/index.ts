import prompt from 'custom-electron-prompt';
import { Howl } from 'howler';
import { Innertube } from 'youtubei.js';

import { t } from '@/i18n';
import { getNetFetchAsFetch } from '@/plugins/utils/main';
import promptOptions from '@/providers/prompt-options';
import { createPlugin } from '@/utils';

import { VolumeFader } from './fader';

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

  async backend({ ipc }) {
    const yt = await Innertube.create({
      fetch: getNetFetchAsFetch(),
    });

    ipc.handle('audio-url', async (videoID: string) => {
      const info = await yt.getBasicInfo(videoID);
      return info.streaming_data?.formats[0].decipher(yt.session.player);
    });
  },

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
      const video = document.querySelector<HTMLVideoElement>('video');

      if (!api || !video) {
        console.error('[crossfade] Player API or video element is unavailable');
        return;
      }

      let transitionAudio: Howl | undefined;
      let currentVideoID = api.getVideoData().video_id;
      let transitionTriggeredForVideoID: string | undefined;
      let awaitingIncomingFade = false;
      let incomingVolume = video.volume;
      let mirrorGeneration = 0;

      const getStreamURL = async (videoID: string): Promise<string | undefined> => {
        try {
          return (await this.ipc?.invoke('audio-url', videoID)) as
            | string
            | undefined;
        } catch (error) {
          console.error('[crossfade] Failed to get stream URL', error);
          return undefined;
        }
      };

      const isReadyToCrossfade = () =>
        transitionAudio?.state() === 'loaded' &&
        transitionAudio._sounds[0]?._node instanceof HTMLMediaElement;

      const syncMirrorToVideo = (audio: Howl) => {
        audio.play();
        audio.seek(video.currentTime);

        if (video.paused) {
          audio.pause();
        }
      };

      const prepareMirror = async (videoID: string) => {
        const generation = ++mirrorGeneration;
        const url = await getStreamURL(videoID);

        if (!url || generation !== mirrorGeneration || videoID !== currentVideoID) {
          return;
        }

        const audio = new Howl({
          src: url,
          html5: true,
          volume: 0,
          onload: () => {
            if (
              generation !== mirrorGeneration ||
              videoID !== currentVideoID
            ) {
              audio.unload();
              return;
            }

            transitionAudio?.unload();
            transitionAudio = audio;
            syncMirrorToVideo(audio);
          },
          onloaderror: (_id, error) => {
            console.error('[crossfade] Failed to load transition audio', error);
          },
        });
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

      const beginOutgoingFade = () => {
        if (!isReadyToCrossfade() || !transitionAudio) {
          return false;
        }

        const outgoingAudio = transitionAudio;
        const outgoingNode = outgoingAudio._sounds[0]?._node;

        if (!(outgoingNode instanceof HTMLMediaElement)) {
          return false;
        }

        if (!outgoingAudio.playing()) {
          outgoingAudio.play();
        }

        incomingVolume = video.volume;
        awaitingIncomingFade = true;
        transitionAudio = undefined;
        video.volume = 0;

        const duration = this.config?.fadeOutDuration ?? 0;
        if (duration <= 0) {
          outgoingNode.volume = 0;
          outgoingAudio.unload();
          return true;
        }

        new VolumeFader(outgoingNode, {
          initialVolume: incomingVolume,
          fadeScaling: this.config?.fadeScaling,
          fadeDuration: duration,
        }).fadeOut(() => {
          outgoingAudio.unload();
        });

        return true;
      };

      video.addEventListener('seeking', () => {
        if (transitionAudio?.state() === 'loaded') {
          transitionAudio.seek(video.currentTime);
        }
      });

      video.addEventListener('pause', () => {
        transitionAudio?.pause();
      });

      video.addEventListener('play', () => {
        if (transitionAudio?.state() === 'loaded') {
          syncMirrorToVideo(transitionAudio);
        }
      });

      video.addEventListener('timeupdate', () => {
        if (
          !currentVideoID ||
          transitionTriggeredForVideoID === currentVideoID ||
          !Number.isFinite(video.duration) ||
          video.currentTime <
            video.duration - (this.config?.secondsBeforeEnd ?? 0) ||
          !isReadyToCrossfade()
        ) {
          return;
        }

        transitionTriggeredForVideoID = currentVideoID;

        if (beginOutgoingFade()) {
          api.nextVideo();
        }
      });

      api.addEventListener('videodatachange', (name, videoData) => {
        if (name !== 'dataloaded' || !videoData.videoId) {
          return;
        }

        const nextVideoID = videoData.videoId;
        if (nextVideoID === currentVideoID) {
          return;
        }

        // A manual skip does not pass through the near-end trigger, so start the
        // outgoing fade here while the old mirrored track is still available.
        if (!awaitingIncomingFade) {
          beginOutgoingFade();
        }

        currentVideoID = nextVideoID;
        transitionTriggeredForVideoID = undefined;

        if (awaitingIncomingFade) {
          const targetVolume = incomingVolume;
          awaitingIncomingFade = false;
          fadeVideoIn(targetVolume);
        }

        void prepareMirror(nextVideoID);
      });

      if (currentVideoID) {
        void prepareMirror(currentVideoID);
      }
    },
  },
});
