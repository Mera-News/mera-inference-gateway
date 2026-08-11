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
import { FactCheckClaimsRequestDto } from './dto/fact-check-claims.dto';
import { ClaimReviewItem, FactCheckClaimsService } from './fact-check-claims.service';

/**
 * `POST /v1/fact-check-claims` — a ClaimReview lookup against Google's Fact
 * Check Tools API. Deliberately shaped exactly like `WebSearchController`: same
 * guard, same DTO-only body, same global throttler, same 200/503/502 contract.
 * Two search-ish routes that answer "did we look?" differently would be the
 * bug this whole change exists to remove.
 *
 * POST, not GET, for the same reason web-search is: the claim text would
 * otherwise sit in the request line, which is the part of a request most likely
 * to end up in an access log.
 *
 * Nothing about the caller reaches Google and nothing about the lookup is
 * logged: no claim text, no user id. Authentication is required and discarded.
 */
@Controller('v1')
@UseGuards(AuthGuard)
export class FactCheckClaimsController {
  private readonly logger = new Logger(FactCheckClaimsController.name);

  constructor(private readonly factCheckClaimsService: FactCheckClaimsService) {}

  @Post('fact-check-claims')
  @HttpCode(200)
  async factCheckClaims(
    @Body() dto: FactCheckClaimsRequestDto,
  ): Promise<{ claimReviews: ClaimReviewItem[] }> {
    try {
      return {
        claimReviews: await this.factCheckClaimsService.searchClaims(
          dto.query,
          dto.languageCode,
          dto.maxAgeDays,
        ),
      };
    } catch (error) {
      // Length rejections (400) and every `search-unavailable` 503 are already
      // HttpExceptions and pass through verbatim — flattening a 503 into a 502
      // here would erase the one distinction the caller branches on.
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Fact check claims lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error.stack : undefined,
      );
      throw new BadGatewayException('Fact check claims lookup failed');
    }
  }
}
