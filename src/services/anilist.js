const ANILIST_URL = 'https://graphql.anilist.co';
const REQUEST_TIMEOUT_MS = 15000;

const SEASON_QUERY = `
  query ($season: MediaSeason, $year: Int, $page: Int) {
    Page(page: $page, perPage: 50) {
      pageInfo { hasNextPage currentPage }
      media(season: $season, seasonYear: $year, type: ANIME, sort: POPULARITY_DESC) {
        id
        idMal
        title { romaji english native }
        nextAiringEpisode { airingAt episode }
        episodes
        averageScore
        coverImage { large }
        genres
        status
      }
    }
  }
`;

async function fetchSeason(season, year) {
  const dataMap = new Map();
  let page = 1;
  let hasNextPage = true;

  const seasonMap = {
    winter: 'WINTER',
    spring: 'SPRING',
    summer: 'SUMMER',
    fall: 'FALL'
  };

  const anilistSeason = seasonMap[season.toLowerCase()] || season.toUpperCase();

  while (hasNextPage) {
    console.log(`[AniList] Fetching ${anilistSeason} ${year}, page ${page}`);
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(ANILIST_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            query: SEASON_QUERY,
            variables: { season: anilistSeason, year, page }
          })
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.errors?.[0]?.message || `AniList error: ${res.status}`);
      }

      const result = await res.json();
      if (result.errors?.length) {
        throw new Error(result.errors[0].message || 'AniList GraphQL error');
      }

      if (!result.data?.Page) {
        throw new Error('AniList response is missing Page data');
      }

      const pageData = result.data.Page;

      for (const media of pageData.media) {
        if (!media.idMal) continue;
        
        const statusMap = {
          'FINISHED': 'Finished Airing',
          'RELEASING': 'Currently Airing',
          'NOT_YET_RELEASED': 'Not yet aired',
          'CANCELLED': 'Cancelled'
        };

        dataMap.set(media.idMal, {
          score_anilist: media.averageScore,
          next_ep_num: media.nextAiringEpisode?.episode || null,
          next_ep_at: media.nextAiringEpisode?.airingAt || null,
          title_jp: media.title?.native || null,
          poster_url: media.coverImage?.large || null,
          anilist_id: media.id,
          genres: media.genres || [],
          airing_status: statusMap[media.status] || null,
          episodes_total: media.episodes
        });
      }

      hasNextPage = pageData.pageInfo.hasNextPage;
      page++;
    } catch (err) {
      console.error(`[AniList] Error:`, err.message);
      break;
    }
  }

  console.log(`[AniList] Fetched ${dataMap.size} anime entries`);
  return dataMap;
}

module.exports = { fetchSeason };
