import { Injectable } from '@nestjs/common';
import { DatabaseService } from '@/processors/database/database.service';
import { OpenaiService } from '@/libs/openai/openai.service';
import { type ChatMessage, ChatMessageRole } from '@prisma/client';
import { Message, OpenAIChatModel, Role } from '@/libs/openai/typing';
import { ConfigService } from '@nestjs/config';
import { Observable } from 'rxjs';
import { BizException } from '@/common/exceptions/biz.exception';
import { ErrorCodeEnum } from 'shared/dist/error-code';

@Injectable()
export class ChatService {
  private openaiConfig;

  constructor(
    private prisma: DatabaseService,
    private openaiService: OpenaiService,
    config: ConfigService,
  ) {
    this.openaiConfig = config.get('openai');
  }

  /* 获取指定用户最近时间内消息的总计，用于limit */
  async getRecentMessageCount(
    userId: number,
    duration: number,
    currentTime?: Date,
  ) {
    currentTime = currentTime || new Date();
    const startTime = new Date(currentTime.getTime() - duration * 1000);

    return this.prisma.chatMessage.count({
      where: {
        userId: userId,
        createdAt: {
          gte: startTime,
          lte: currentTime,
        },
      },
    });
  }

  /* 用量限制 */
  async limitCheck(userId: number, mid: number) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    const currentTime = new Date();
    const orders = await this.prisma.order.findMany({
      where: {
        AND: [
          {
            startAt: {
              lte: currentTime,
            },
          },
          {
            endAt: {
              gte: currentTime,
            },
          },
        ],
      },
    });
    const productId = orders.length !== 0 ? orders[0].productId : 1;

    const limit = await this.prisma.modelInProduct.findUniqueOrThrow({
      where: {
        modelId_productId: {
          modelId: mid,
          productId: productId,
        },
      },
    });
    const messageCount = await this.getRecentMessageCount(
      userId,
      limit.duration,
      currentTime,
    );
    if (limit.times - messageCount > 0) {
      return true;
    }
    return false;
  }

  /* */
  async getOrNewChatSession(
    sessionId: string,
    userId: number,
    memoryPrompt?: string,
    limit = 10,
  ) {
    return this.prisma.$transaction(async (prisma) => {
      const chatSession = await this.prisma.chatSession.upsert({
        where: {
          id: sessionId,
        },
        update: {
          memoryPrompt,
        },
        create: {
          id: sessionId,
          memoryPrompt,
          user: { connect: { id: userId } },
        },
        include: {
          messages: {
            take: limit,
            orderBy: {
              createdAt: 'asc',
            },
          },
        },
      });
      if (chatSession.userId !== userId) {
        throw new BizException(ErrorCodeEnum.ValidationError);
      }
      return chatSession;
    });
  }

  /* 获取消息 */
  async getChatMessages(uid: number, sid: string, limit = 10) {
    return this.prisma.chatSession.findUnique({
      where: {
        id: sid,
        userId: uid,
      },
      include: {
        messages: {
          // take: limit,
          orderBy: {
            createdAt: 'asc',
          },
        },
      },
    });
  }

  /* 获取最近对话 */
  async getRecentChatSession(uid: number, limit = 10) {
    return this.prisma.chatSession.findMany({
      take: limit,
      where: {
        userId: uid,
      },
      include: {
        _count: {
          select: {
            messages: true,
          },
        },
      },
    });
  }

  /* 指定对话中创建新消息 */
  async newMessageStream({
    userId,
    sessionId,
    content,
    modelId,
    messages,
    key,
  }: {
    userId: number;
    sessionId: string;
    modelId: number;
    content: string;
    messages: ChatMessage[];
    /* Request API Key */
    key: string;
  }): Promise<Observable<{ data: string }>> {
    const { name: model } = await this.prisma.model.findUniqueOrThrow({
      where: { id: modelId },
    });

    const history: Message[] = messages.map(({ role, content }) => ({
      role: role.toLowerCase() as Role,
      content,
    }));

    const tokenStream = this.openaiService.requestStream(
      {
        apiKey: key,
        messages: [...history, { role: 'user', content }],
        model: model as OpenAIChatModel,
      },
      async (generated) => {
        const time = Date.now();
        await this.prisma.$transaction([
          // save both messages
          this.prisma.chatMessage.create({
            data: {
              role: ChatMessageRole.User,
              content,
              userId: userId,
              chatSessionId: sessionId,
              createdAt: new Date(time),
            },
          }),
          this.prisma.chatMessage.create({
            data: {
              role: ChatMessageRole.Assistant,
              content: generated,
              userId: userId,
              modelId: modelId,
              chatSessionId: sessionId,
              createdAt: new Date(time + 1),
            },
          }),
        ]);
      },
    );

    return new Observable((subscriber) => {
      (async () => {
        try {
          for await (const token of tokenStream) {
            subscriber.next({ data: JSON.stringify(token) });
          }
        } catch (e) {
          console.warn('[Caught Error]', e);
        } finally {
          subscriber.complete();
        }
      })();
    });
  }
}
