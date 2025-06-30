import { Innertube, UniversalCache } from "youtubei.js";
import { MusicInlineBadge } from "youtubei.js/dist/src/parser/nodes";
import { Hono } from "hono";
import { jwt } from 'hono/jwt';
import type { JwtVariables } from 'hono/jwt';

const innertube = await Innertube.create({
    lang: 'en',
    location: 'US',
    retrieve_player: true,
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

const secret = Bun.env.JWT_SECRET;
if (secret === undefined || secret === '') {
    console.error('Missing JWT_SECRET');
    process.exit(1);
}

app.use(
    '/search',
    jwt({
        secret: secret,
    })
);

app.get('/search', async (c) => {
    const query = c.req.query('query');
    if (query === '' || query === undefined) {
        c.status(400);
        return c.json({
            error: 'empty query',
        });
    }

    console.log(`Received search request for query: ${decodeURI(query)}`);

    try {
        const search = await innertube.music.search(decodeURI(query), {
            type: 'song'
        });

        const result = search.songs.contents.slice(0, 5).map(song => {
            const artists = song.artists?.map(x => x.name).join(', ');
            const durationSec = song.duration?.seconds!;
            const explicit = song.badges?.find(item => {
                const badge = item as MusicInlineBadge;
                return badge.icon_type === 'MUSIC_EXPLICIT_BADGE';
            }) !== undefined;

            return {
                id: song.id,
                title: song.title,
                authors: artists,
                thumbnail: song.thumbnail!.contents[song.thumbnails!.length - 1].url,
                length: durationSec,
                explicit: explicit
            }
        });

        console.log(result);

        return c.json(result);
    } catch (error) {
        console.error(error);
        c.status(500);
        return c.json({
            error: error,
        })
    }
});

export default app