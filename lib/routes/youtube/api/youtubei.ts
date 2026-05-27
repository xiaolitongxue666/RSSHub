import { Innertube } from 'youtubei.js';

import type { Data } from '@/types';
import cache from '@/utils/cache';
import { parseRelativeDate } from '@/utils/parse-date';

import utils, { getVideoUrl } from '../utils';
import { getSrtAttachmentBatch } from './subtitles';

let innertubePromise: Promise<Innertube> | undefined;

/** youtubei.js Tab：新版频道页视频在 current_tab.content.contents（LockupView），.videos 可能为空 */
function extractVideosFromTab(tab: any) {
    const fromMemo = tab.videos?.filter((video) => video && 'video_id' in video && video.video_id) ?? [];
    if (fromMemo.length > 0) {
        return fromMemo;
    }
    const contents = tab.current_tab?.content?.contents;
    if (!Array.isArray(contents)) {
        return [];
    }
    return contents
        .map((entry) => entry?.content)
        .filter((content): content is Record<string, unknown> => !!content && content.content_type === 'VIDEO' && typeof content.content_id === 'string')
        .map((content) => {
            const videoId = content.content_id as string;
            const thumbFromImage = Array.isArray(content.image) ? (content.image[0] as { url?: string })?.url : undefined;
            const thumbUrl = thumbFromImage || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
            return {
                video_id: videoId,
                title: { text: (content.metadata as { title?: { text?: string } })?.title?.text ?? (content.title as { text?: string })?.text ?? `YouTube Video ${videoId}` },
                best_thumbnail: { url: thumbUrl },
                thumbnails: content.image,
            };
        });
}

const getInnertube = () => {
    if (!innertubePromise) {
        // Lazy init to avoid network calls during import time (e.g. when building)
        innertubePromise = Innertube.create({
            enable_safety_mode: false,
            fetch: (input, init) => {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

                return fetch(url, {
                    method: input?.method,
                    ...init,
                });
            },
        });
    }
    return innertubePromise;
};

export const getChannelIdByUsername = (username: string) =>
    cache.tryGet(`youtube:getChannelIdByUsername:${username}`, async () => {
        const innertube = await getInnertube();
        const navigationEndpoint = await innertube.resolveURL(`https://www.youtube.com/${username}`);
        return navigationEndpoint.payload.browseId;
    });

export const getDataByUsername = async ({ username, embed, filterShorts, isJsonFeed }: { username: string; embed: boolean; filterShorts: boolean; isJsonFeed: boolean }): Promise<Data> => {
    const channelId = (await getChannelIdByUsername(username)) as string;
    return getDataByChannelId({ channelId, embed, filterShorts, isJsonFeed });
};

export const getDataByChannelId = async ({ channelId, embed, isJsonFeed }: { channelId: string; embed: boolean; filterShorts: boolean; isJsonFeed: boolean }): Promise<Data> => {
    const innertube = await getInnertube();
    const channel = await innertube.getChannel(channelId);
    const videosTab = await channel.getVideos();
    const videoList = extractVideosFromTab(videosTab);
    const videoSubtitles = isJsonFeed ? await getSrtAttachmentBatch(videoList.filter((video) => 'video_id' in video).map((video) => video.video_id)) : {};

    return {
        title: `${channel.metadata.title || channelId} - YouTube`,
        link: `https://www.youtube.com/channel/${channelId}`,
        image: channel.metadata.avatar?.[0].url,
        description: channel.metadata.description,

        item: await Promise.all(
            videoList
                .filter((video) => 'video_id' in video)
                .map((video) => {
                    const srtAttachments = isJsonFeed ? videoSubtitles[video.video_id] || [] : [];
                    const thumbUrl =
                        ('best_thumbnail' in video ? video.best_thumbnail?.url : undefined) ??
                        ('thumbnails' in video && Array.isArray(video.thumbnails) ? (video.thumbnails[0] as { url?: string })?.url : undefined) ??
                        (video.video_id ? `https://i.ytimg.com/vi/${video.video_id}/hqdefault.jpg` : undefined);
                    const imgObj = thumbUrl ? { url: thumbUrl } : undefined;
                    const descHtml =
                        'description_snippet' in video && video.description_snippet
                            ? utils.formatDescription(video.description_snippet?.toHTML())
                            : '';

                    return {
                        title: video.title?.text || `YouTube Video ${video.video_id}`,
                        description: utils.renderDescription(embed, video.video_id, imgObj, descHtml),
                        link: `https://www.youtube.com/watch?v=${video.video_id}`,
                        author: typeof video.author === 'string' ? video.author : video.author?.name && video.author.name !== 'N/A' ? video.author.name : undefined,
                        image: thumbUrl,
                        pubDate: 'published' in video && video.published?.text ? parseRelativeDate(video.published.text) : undefined,
                        attachments: [
                            {
                                url: getVideoUrl(video.video_id),
                                mime_type: 'text/html',
                                duration_in_seconds: video.duration && 'seconds' in video.duration ? video.duration.seconds : undefined,
                            },
                            ...srtAttachments,
                        ],
                    };
                })
        ),
    };
};

export const getDataByPlaylistId = async ({ playlistId, embed }: { playlistId: string; embed: boolean; isJsonFeed: boolean }): Promise<Data> => {
    const innertube = await getInnertube();
    const playlist = await innertube.getPlaylist(playlistId);
    const videos = await playlist.videos;

    return {
        title: `${playlist.info.title || playlistId} by ${playlist.info.author.name} - YouTube`,
        link: `https://www.youtube.com/playlist?list=${playlistId}`,
        image: playlist.info.thumbnails?.[0].url,
        description: playlist.info.description || `${playlist.info.title} by ${playlist.info.author.name}`,

        item: videos
            .filter((video) => 'id' in video)
            .map((video) => {
                const img = 'best_thumbnail' in video ? video.best_thumbnail?.url : video.thumbnails?.[0]?.url;

                return {
                    title: video.title.text || `YouTube Video ${video.id}`,
                    description: utils.renderDescription(embed, video.id, img, ''),
                    link: `https://www.youtube.com/watch?v=${video.id}`,
                    pubDate: 'published' in video && video.published?.text ? parseRelativeDate(video.published.text) : undefined,
                    author:
                        'author' in video
                            ? [
                                  {
                                      name: video.author.name,
                                      url: video.author.url,
                                      avatar: video.author.thumbnails?.[0]?.url,
                                  },
                              ]
                            : undefined,
                    image: img,
                    attachments: [
                        {
                            url: getVideoUrl(video.id),
                            mime_type: 'text/html',
                            duration_in_seconds: 'duration' in video && video.duration && 'seconds' in video.duration ? video.duration.seconds : undefined,
                        },
                    ],
                };
            }),
    };
};
