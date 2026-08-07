import { Module } from '@nestjs/common';
import { WebSearchController } from './web-search.controller';
import { WEB_SEARCH_FETCH, WebSearchService } from './web-search.service';

/**
 * Composition root for web search. `fetch` is bound here as a provider so specs
 * inject a stub and never touch the network — the service itself holds no
 * reference to the global.
 */
@Module({
  controllers: [WebSearchController],
  providers: [
    WebSearchService,
    {
      provide: WEB_SEARCH_FETCH,
      useValue: globalThis.fetch.bind(globalThis),
    },
  ],
})
export class WebSearchModule {}
