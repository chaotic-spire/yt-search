import {Innertube, UniversalCache} from "youtubei.js";
// @ts-ignore
import {MusicInlineBadge} from "youtubei.js/dist/src/parser/nodes";
import {Hono} from "hono";
import type {JwtVariables} from 'hono/jwt';
import {jwt} from 'hono/jwt';

const secret = Bun.env.JWT_SECRET;
if (secret === undefined || secret === '') {
    console.error('Missing JWT_SECRET');
    process.exit(1);
}

const cobaltUrl = Bun.env.COBALT_URL ?? 'http://localhost:9000';

const innertube = await Innertube.create({
    lang: 'en',
    location: 'US',
    retrieve_player: false,
    enable_safety_mode: false,
    generate_session_locally: false,
    enable_session_cache: true,
    device_category: 'desktop',
    cookie: '',
    cache: new UniversalCache(
        true,
        './cache'
    )
});

type Variables = JwtVariables;
const app = new Hono<{ Variables: Variables }>();

interface Metadata {
    length: number;
    title: string;
    authors: string;
    thumbnail: string;
    album: string;
    filename: string;
}

interface CobaltData {
    status: string;
    url: string;
    filename: string;
}

async function runCmd(cmd: string[]): Promise<number> {
    const ffmpeg = Bun.spawn({
        cmd: cmd,
        stdout: 'inherit',
        stderr: 'inherit',
    });

    return await ffmpeg.exited;
}

async function getCobalt(id: string): Promise<CobaltData> {
    const resp = await fetch(cobaltUrl, {
        method: 'POST',
        headers: {
            'accept': 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            url: 'https://youtube.com/watch?v='+id,
            audioFormat: 'best',
            downloadMode: 'audio',
            filenameStyle: 'basic',
            disableMetadata: false,
            alwaysProxy: false,
            localProcessing: false,
        })
    });

    return await resp.json() as {
        status: string,
        url: string,
        filename: string,
    };
}

async function dl(id: string, metadata: Metadata): Promise<void> {
    const data = await getCobalt(id);

    console.log(data);

    const fixedFile = `./dl/${id}/audio.m4a`;

    const audioCmd = [
        'ffmpeg',
        '-y',
        '-i', data.url,
        '-i', metadata.thumbnail, '-map', '0', '-map', '1', '-disposition:v:0', 'attached_pic', // set cover
        '-c:a', 'aac',
        '-vn',
        '-t', metadata.length.toString(),
        '-metadata', `title="${metadata.title}"`,
        '-metadata', `artist="${metadata.authors}"`,
        '-metadata', `album="${metadata.album}"`,
        fixedFile,
    ];

    console.log(audioCmd.join(' '));

    const audio = await runCmd(audioCmd);

    console.log(`${id} audio downloaded`);

    const hlsCmd = [
        'ffmpeg',
        '-y',
        '-i', fixedFile,
        '-c:a', 'aac',
        '-f', 'hls',
        '-vn',
        '-t', metadata.length.toString(),
        '-hls_playlist_type', 'vod',
        '-hls_segment_filename', `./dl/${id}/segment_%03d.ts`,
        `./dl/${id}/hls.m3u8`
    ];

    console.log(hlsCmd.join(' '));

    const hls = await runCmd(hlsCmd);

    console.log(`${id}: audio - ${audio}, hls - ${hls}`);
}

async function search(query: string): Promise<{
    id: string | undefined;
    title: string | undefined;
    authors: string | undefined;
    thumbnail: string | undefined;
    length: number;
    explicit: boolean
}[]> {
    const search = await innertube.music.search(decodeURI(query), {
        type: 'song'
    });

    if (!search.songs) {
        return [];
    }

    return await Promise.all(search.songs.contents.map(async song => {
        const artists = song.artists?.map(x => x.name).join(', ')!;
        const cover = song.thumbnail?.contents[song.thumbnails!.length - 1]?.url!;
        const info = await innertube.getInfo(song.id!);
        const duration = info.basic_info.duration!;
        const explicit = song.badges?.find(item => {
            const badge = item as MusicInlineBadge;
            return badge.icon_type === 'MUSIC_EXPLICIT_BADGE';
        }) !== undefined;

        const manifest = {
            id: song.id!,
            title: song.title!,
            authors: artists,
            album: song.album?.name!,
            thumbnail: cover,
            length: duration,
            explicit: explicit,
        };

        await Bun.write(`./dl/${song.id!}/manifest.json`, JSON.stringify(manifest));

        return manifest;
    }));
}

app.use(
    '/api/*',
    jwt({
        secret: secret,
    })
);

app.get('/api/search', async (c) => {
    const query = c.req.query('query');
    if (query === '' || query === undefined) {
        return c.json([]);
    }

    console.log(`Received search request for query: ${decodeURI(query)}`);

    try {
        const result = await search(query);

        return c.json(result);
    } catch (error) {
        console.error(error);
        c.status(500);
        return c.json({
            error: error,
        })
    }
});

app.get('/api/dl', async (c) => {
    const id = c.req.query('id');
    if (id === '' || id === undefined) {
        return c.json({});
    }

    console.log(`Received dl request for id: ${id}`);

    const metaFile = Bun.file(`./dl/${id}/manifest.json`);

    const metadata = await metaFile.json() as Metadata;
    const data = await getCobalt(id);
    metadata.filename = data.filename;
    await Bun.write(`./dl/${id}/manifest.json`, JSON.stringify(metadata));

    await dl(id, metadata);

    return c.json({})
});

app.get('/api/dl/:id/:file', async (c) => {
    const id = c.req.param('id');
    if (id === '' || id === undefined) {
        return c.json({});
    }

    const file = c.req.param('file');
    if (file === '' || file === undefined) {
        return c.json({});
    }

    file.replaceAll('..', '');

    const blob = Bun.file(`./dl/${id}/${file}`);
    const arrbuf = await blob.arrayBuffer();
    const buffer = Buffer.from(arrbuf);

    return c.body(buffer, {
        headers: {
            'Content-Type': 'application/octet-stream',
        }
    });
})

export default app