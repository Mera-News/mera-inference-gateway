import {
  BadGatewayException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '../auth/auth.guard';
import { WebSearchRequestDto } from './dto/web-search.dto';
import { WebSearchService, WebSearchResultItem } from './web-search.service';

/**
 * `POST /v1/web-search` — the one route on this gateway that handles plaintext.
 * It exists here rather than on the news API because web search feeds the chat
 * model's context, so it belongs on the inference path the app already talks to
 * during a chat turn.
 *
 * Nothing about the caller is forwarded to Brave and nothing about the search is
 * logged: no query text, no user id. Authentication is required (AuthGuard) and
 * then discarded.
 */
@Controller('v1')
@UseGuards(AuthGuard)
export class WebSearchController {
  private readonly logger = new Logger(WebSearchController.name);

  constructor(private readonly webSearchService: WebSearchService) {}

  @Post('web-search')
  @HttpCode(200)
  async webSearch(@Body() dto: WebSearchRequestDto): Promise<{ results: WebSearchResultItem[] }> {
    try {
      return { results: await this.webSearchService.search(dto.query) };
    } catch (error) {
      // Length rejections (400) are the caller's problem and pass through
      // verbatim; anything else is an upstream/config failure.
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Web search failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new BadGatewayException('Web search failed');
    }
  }
}
