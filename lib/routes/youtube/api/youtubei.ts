import { Innertube, YTNodes } from 'youtubei.js';

import type { Data, DataItem } from '@/types';
import cache from '@/utils/cache';
import { parseRelativeDate } from '@/utils/parse-date';

import { getVideoUrl, renderYoutube } from '../utils';
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
                const url = input instanceof Request ? input.url : input.toString();

                return fetch(url, {
                    method: input?.method,
                    ...init,
                });
            },
        });
    }
    return innertubePromise;
};

const lockupViewToItem = (video: YTNodes.LockupView, embed: boolean): DataItem => {
    const videoId = video.content_id;
    const thumbnail = video.content_image?.is(YTNodes.ThumbnailView) ? video.content_image : undefined;
    const img = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
    const metadataRows = video.metadata?.metadata?.metadata_rows ?? [];
    const publishedText = metadataRows
        .flatMap((row) => row.metadata_parts ?? [])
        .map((part) => part.text?.text)
        .findLast((text) => text?.endsWith('ago'));
    const durationText = thumbnail?.overlays
        ?.filter((overlay) => overlay.is(YTNodes.ThumbnailBottomOverlayView))
        .flatMap((overlay) => overlay.badges ?? [])
        .find((badge) => /^\d+(?::\d+)+$/.test(badge.text))?.text;

    return {
        title: video.metadata?.title?.text || `YouTube Video ${videoId}`,
        description: renderYoutube(embed, videoId, img, ''),
        link: `https://www.youtube.com/watch?v=${videoId}`,
        author: metadataRows.length > 1 ? metadataRows[0].metadata_parts?.[0]?.text?.text : undefined,
        image: img,
        pubDate: publishedText ? parseRelativeDate(publishedText) : undefined,
        attachments: [
            {
                url: getVideoUrl(videoId),
                mime_type: 'text/html',
                duration_in_seconds: durationText ? durationText.split(':').reduce((acc, part) => acc * 60 + Number(part), 0) : undefined,
            },
        ],
    };
};

export const getChannelIdByUsername = (username: string) =>
    cache.tryGet<string>(`youtube:getChannelIdByUsername:${username}`, async () => {
        const innertube = await getInnertube();
        const navigationEndpoint = await innertube.resolveURL(`https://www.youtube.com/${username}`);
        return navigationEndpoint.payload.browseId;
    });

export const getDataByUsername = async ({ username, embed, filterShorts, isJsonFeed }: { username: string; embed: boolean; filterShorts: boolean; isJsonFeed: boolean }): Promise<Data> => {
    const channelId = await getChannelIdByUsername(username);
    return getDataByChannelId({ channelId, embed, filterShorts, isJsonFeed });
};

export const getDataByChannelId = async ({ channelId, embed, isJsonFeed }: { channelId: string; embed: boolean; filterShorts: boolean; isJsonFeed: boolean }): Promise<Data> => {
    const innertube = await getInnertube();
    const channel = await innertube.getChannel(channelId);
    const videos = await channel.getVideos();
    const lockupVideos = videos.videos.filter((video) => video instanceof YTNodes.LockupView);
    const feedMeta = {
        title: `${channel.metadata.title || channelId} - YouTube`,
        link: `https://www.youtube.com/channel/${channelId}`,
        image: channel.metadata.avatar?.[0].url,
        description: channel.metadata.description,
    };

    if (lockupVideos.length > 0) {
        const videoSubtitles = isJsonFeed ? await getSrtAttachmentBatch(lockupVideos.map((video) => video.content_id)) : {};
        return {
            ...feedMeta,
            item: lockupVideos.map((video) => {
                const item = lockupViewToItem(video, embed);
                item.attachments?.push(...(isJsonFeed ? videoSubtitles[video.content_id] || [] : []));
                return item;
            }),
        };
    }

    const videoList = extractVideosFromTab(videos);
    const fallbackIds = videoList.filter((video) => 'video_id' in video).map((video) => video.video_id);
    const videoSubtitles = isJsonFeed ? await getSrtAttachmentBatch(fallbackIds) : {};

    return {
        ...feedMeta,
        item: videoList
            .filter((video) => 'video_id' in video)
            .map((video) => {
                const srtAttachments = isJsonFeed ? videoSubtitles[video.video_id] || [] : [];
                const thumbUrl =
                    ('best_thumbnail' in video ? video.best_thumbnail?.url : undefined) ??
                    ('thumbnails' in video && Array.isArray(video.thumbnails) ? (video.thumbnails[0] as { url?: string })?.url : undefined) ??
                    (video.video_id ? `https://i.ytimg.com/vi/${video.video_id}/hqdefault.jpg` : undefined);
                const descHtml = 'description_snippet' in video && video.description_snippet ? String(video.description_snippet) : '';

                return {
                    title: video.title?.text || `YouTube Video ${video.video_id}`,
                    description: renderYoutube(embed, video.video_id, thumbUrl || '', descHtml),
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
            }),
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

        item: videos.filter((video) => video instanceof YTNodes.LockupView).map((video) => lockupViewToItem(video, embed)),
    };
};
