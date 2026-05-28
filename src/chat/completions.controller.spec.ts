import { Logger } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { ChatService } from './chat.service';
import { CompletionsController } from './completions.controller';
import { InferenceQueueService } from './inference-queue.service';

function makeRes(): Response & {
  status: jest.Mock;
  json: jest.Mock;
} {
  const res: Record<string, jest.Mock> = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.setHeader = jest.fn().mockReturnValue(res);
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock };
}

function makeReq(body: unknown): AuthenticatedRequest {
  return {
    body,
    headers: {},
    user: { id: 'user-1', subscriptionIsActive: true },
  } as unknown as AuthenticatedRequest;
}

describe('CompletionsController (batch)', () => {
  let chatService: { proxyChat: jest.Mock };
  let queue: {
    canAccept: jest.Mock;
    snapshot: jest.Mock;
    run: jest.Mock;
  };
  let controller: CompletionsController;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    chatService = { proxyChat: jest.fn() };
    queue = {
      canAccept: jest.fn(),
      snapshot: jest.fn().mockReturnValue({ active: 0, waiting: 0 }),
      run: jest.fn((task: () => Promise<unknown>) => task()),
    };
    controller = new CompletionsController(
      chatService as unknown as ChatService,
      queue as unknown as InferenceQueueService,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns 400 when `requests` is missing or empty', async () => {
    const res = makeRes();
    await controller.batchChatCompletions(makeReq({ requests: [] }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(chatService.proxyChat).not.toHaveBeenCalled();
  });

  it('returns 503 when the queue cannot accept the batch', async () => {
    queue.canAccept.mockReturnValue(false);
    const res = makeRes();

    await controller.batchChatCompletions(makeReq({ requests: [{ model: 'm' }] }), res);

    expect(queue.canAccept).toHaveBeenCalledWith(1);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Inference queue full, retry later',
    });
    expect(chatService.proxyChat).not.toHaveBeenCalled();
  });

  it('processes the batch when the queue can accept it', async () => {
    queue.canAccept.mockReturnValue(true);
    chatService.proxyChat.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ id: 'c1', choices: [{ finish_reason: 'stop' }] }),
    });
    const res = makeRes();

    await controller.batchChatCompletions(makeReq({ requests: [{ model: 'm' }] }), res);

    expect(queue.run).toHaveBeenCalledTimes(1);
    expect(chatService.proxyChat).toHaveBeenCalledTimes(1);
    const payload = res.json.mock.calls[0][0] as {
      results: Array<{ index: number; response?: unknown }>;
    };
    expect(payload.results).toHaveLength(1);
    expect(payload.results[0].index).toBe(0);
  });
});
