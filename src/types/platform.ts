import type { PlatformScopeRef } from './core.js';

export type InboundAttachmentKind = 'image' | 'voice' | 'file' | 'video';

export interface InboundAttachment {
  kind: InboundAttachmentKind;
  localPath: string;
  fileName?: string | null;
  mimeType?: string | null;
  transcriptText?: string | null;
  durationSeconds?: number | null;
}

export interface InboundTextEvent extends PlatformScopeRef {
  text: string;
  attachments?: InboundAttachment[];
  cwd?: string | null;
  locale?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PlatformDeliveryRequest {
  kind: string;
  payload: Record<string, unknown>;
}

export interface PlatformTextDeliveryResult {
  success: boolean;
  /** Deliveries sent by this call, not counting any skipped prefix. */
  deliveredCount: number;
  deliveredText: string;
  failedIndex: number | null;
  failedText: string;
  error: string;
  errorCode?: number | null;
  /** Deliveries the content splits into, including a skipped prefix. */
  totalDeliveryCount?: number;
}

export interface PlatformMediaDeliveryResult {
  success: boolean;
  messageId: string | null;
  sentPath: string;
  sentCaption: string;
  error: string;
  errorCode?: number | null;
}

export interface PlatformStatusInfo {
  data?: Record<string, unknown> | null;
}

export interface TypingDeliveryRequest {
  externalScopeId: string;
  action: 'start' | 'stop';
}

export interface PlatformPluginContract {
  id: string;
  displayName: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  normalizeInboundEvent(payload: Record<string, unknown>): InboundTextEvent | null | Promise<InboundTextEvent | null>;
  buildTextDeliveries(params: {
    externalScopeId: string;
    content: string;
  }): PlatformDeliveryRequest[];
  sendText?(params: {
    externalScopeId: string;
    content: string;
    /**
     * Leading deliveries to skip because a previous attempt already delivered
     * them. Chunk boundaries stay stable only when every attempt splits the
     * same full content, so a resume passes the whole text plus this offset
     * rather than the leftover text.
     */
    skipDeliveryCount?: number;
    /**
     * Derives each delivery's client id from this seed and its index instead of
     * at random, so a later attempt at the same delivery reuses the same id.
     */
    clientIdSeed?: string | null;
  }): Promise<PlatformTextDeliveryResult | null | undefined>;
  sendTyping?(params: {
    externalScopeId: string;
    status: 'start' | 'stop';
  }): Promise<void> | void;
  sendMedia?(params: {
    externalScopeId: string;
    filePath: string;
    caption?: string | null;
  }): Promise<PlatformMediaDeliveryResult | null | undefined>;
  getStatus?(params: {
    externalScopeId?: string | null;
  }): Promise<PlatformStatusInfo | null | undefined> | PlatformStatusInfo | null | undefined;
}
