// Display helpers for the welcome wizard's category picker.
// Labels are stored lower-case (they are fed to the classifier verbatim), so
// display is sentence case: first letter capitalised, nothing else — except
// a few acronyms that read wrong in lower case.

export { displayLabel } from '../../shared/labels';

// One muted example line per built-in category (research: explain a category
// by example at the moment of choice — SmartBlocker blocks pages, not sites,
// so examples are page kinds rather than app names). Custom categories have
// no example line.
const EXAMPLES: Record<string, string> = {
  'programming and software development': 'Coding tutorials, dev blogs, conference talks',
  'video games': 'Game guides, Twitch streams, Steam store pages',
  'finance and investing': 'Stock tickers, crypto prices, market news',
  'memes and entertainment': 'Meme pages, viral clips, celebrity gossip',
  'news and politics': 'Headlines, opinion pieces, election coverage',
  'science and education': 'Lectures, explainers, pop-science videos',
  music: 'Music videos, playlists, album reviews',
  sports: 'Highlights, live scores, transfer rumours',
  'online shopping': 'Product pages, deals, wish lists',
  'social media and networking': 'Feeds, reels, short videos, comment threads',
  'gambling and betting': 'Online casinos, sports betting, odds',
  'movies and tv shows': 'Trailers, episode recaps, streaming pages',
  'adult content': 'Explicit sites and videos',
};

export function labelExample(label: string): string | undefined {
  return EXAMPLES[label];
}
