/*
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The chat host's logic without the UI: the `MessageProcessor` with the basic
 * and MCP catalogs, the summary subscription, turns to the agent and the
 * `a2ui.mcpAppMessage` actions coming back from the board app. `app.ts` wraps
 * it in a Lit element; the tests drive it directly.
 */

import type {Part} from '@a2a-js/sdk';
import {
  configureMcpCatalog,
  mcpCatalog,
  type McpClientResolver,
  type McpToolClient,
} from '@a2ui/catalog-mcp';
import {
  basicCatalog,
  MessageProcessor,
  type ActionPayload,
  type SurfaceModel,
} from '@a2ui/web_core/v1_0';
import {a2uiDataPart, type A2aDirection, type AgentClient, type AgentReply} from './a2a.js';
import {attachBoardSummary, BOARD_PATH, KANBAN_SURFACE_ID} from './summary.js';

/** Action name the `McpApp` host dispatches for an app's `ui/message` request. */
export const MCP_APP_MESSAGE_ACTION = 'a2ui.mcpAppMessage';

/** Data model keys that are too big or too raw to send with every turn. */
const OMITTED_DATA_MODEL_KEYS: ReadonlySet<string> = new Set(['board', 'toolResult']);

/** Maximum length for inline HTML bundle fields when formatted in the debug pane. */
const MAX_INLINE_HTML_PREVIEW = 120;

/** One line of the conversation. */
export interface ChatEntry {
  readonly role: 'user' | 'agent' | 'system';
  readonly text: string;
}

/** What the host needs from its surroundings. */
export interface KanbanHostOptions {
  readonly agent: AgentClient;
  /** Resolves the MCP client that runs a tool the board app calls. */
  readonly getMcpClientForTool: McpClientResolver;
  /** Called after every change the UI should reflect. */
  readonly onChange?: () => void;
}

/** A content block of a `ui/message` request, as the `McpApp` host forwards it. */
interface MessageContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly _meta?: unknown;
}

type DebugPostMessageFn = Window['postMessage'] & {
  __a2uiDebugListeners?: Set<(payload: Record<string, unknown>) => void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a postMessage payload is a JSON-RPC 2.0 message exchanged with an MCP App frame. */
export function isMcpJsonRpcMessage(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value['jsonrpc'] === '2.0';
}

/**
 * Formats a literal A2UI or MCP JSON-RPC message for the debug pane, abbreviating only
 * multi-kilobyte inline HTML bundle strings (`html` / `htmlContent`) so the full JSON
 * structure remains readable.
 */
export function formatDebugPayload(payload: unknown): string {
  return JSON.stringify(
    payload,
    (key, value: unknown) => {
      if (
        (key === 'html' || key === 'htmlContent') &&
        typeof value === 'string' &&
        value.length > MAX_INLINE_HTML_PREVIEW
      ) {
        return `${value.slice(0, MAX_INLINE_HTML_PREVIEW)}… (${value.length} chars)`;
      }
      return value;
    },
    2,
  );
}

/** Short label summarizing an A2A, A2UI or MCP JSON-RPC message in the debug pane header. */
export function summarizeDebugPayload(payload: Record<string, unknown>): string {
  if (typeof payload['method'] === 'string') {
    return payload['method'];
  }
  if ('id' in payload && ('result' in payload || 'error' in payload)) {
    const result = payload['result'];
    const kind =
      isRecord(result) && typeof result['kind'] === 'string' ? ` (${result['kind']})` : '';
    return `rpc response #${String(payload['id'])}${kind}`;
  }
  for (const key of ['createSurface', 'updateDataModel', 'updateComponents', 'deleteSurface']) {
    if (key in payload) {
      return key;
    }
  }
  return 'message';
}

function attachPostMessageInterceptor(
  targetWindow: Window,
  listener: (payload: Record<string, unknown>) => void,
): () => void {
  try {
    const current = targetWindow.postMessage as DebugPostMessageFn;
    if (current.__a2uiDebugListeners) {
      current.__a2uiDebugListeners.add(listener);
      return () => {
        current.__a2uiDebugListeners?.delete(listener);
      };
    }
    const listeners = new Set<(payload: Record<string, unknown>) => void>([listener]);
    const original = current.bind(targetWindow);
    const wrapped = ((
      message: unknown,
      targetOriginOrOptions?: unknown,
      transfer?: Transferable[],
    ) => {
      if (isMcpJsonRpcMessage(message)) {
        for (const callback of listeners) {
          callback(message);
        }
      }
      if (typeof targetOriginOrOptions === 'string') {
        original(message, targetOriginOrOptions, transfer);
      } else {
        original(message, targetOriginOrOptions as WindowPostMessageOptions | undefined);
      }
    }) as DebugPostMessageFn;
    wrapped.__a2uiDebugListeners = listeners;
    targetWindow.postMessage = wrapped;
    return () => {
      listeners.delete(listener);
    };
  } catch {
    return () => {};
  }
}

export class KanbanHost {
  readonly processor: MessageProcessor;
  readonly entries: ChatEntry[] = [];
  /** Literal A2A JSON-RPC requests the host sent to the agent. */
  readonly hostToAgentMessages: Record<string, unknown>[] = [];
  /** Literal A2A JSON-RPC responses the agent returned to the host. */
  readonly agentToHostMessages: Record<string, unknown>[] = [];
  /** Literal A2UI messages received by the client from the agent. */
  readonly a2uiMessages: Record<string, unknown>[] = [];
  /** Literal MCP JSON-RPC messages sent from the host to the MCP App. */
  readonly hostToMcpMessages: Record<string, unknown>[] = [];
  /** Literal MCP JSON-RPC messages sent from the MCP App to the host. */
  readonly mcpToHostMessages: Record<string, unknown>[] = [];
  private busy = false;
  private readonly detachSummary = new Map<string, () => void>();

  constructor(private readonly options: KanbanHostOptions) {
    this.processor = new MessageProcessor(
      [basicCatalog, mcpCatalog],
      action => {
        void this.handleAction(action);
      },
      {version: 'v1.0'},
    );
    configureMcpCatalog({
      getMcpClientForTool: options.getMcpClientForTool,
      processor: this.processor,
    });
    this.processor.model.onSurfaceCreated.subscribe(surface => {
      this.detachSummary.get(surface.id)?.();
      this.detachSummary.set(surface.id, attachBoardSummary(surface));
      surface.onError.subscribe(error => {
        this.push('system', `Surface error on ${surface.id}: ${error.message ?? String(error)}`);
      });
      this.notify();
    });
    this.processor.model.onSurfaceDeleted.subscribe(surfaceId => {
      this.detachSummary.get(surfaceId)?.();
      this.detachSummary.delete(surfaceId);
      this.notify();
    });
  }

  /** Whether a turn is in flight. */
  get isBusy(): boolean {
    return this.busy;
  }

  /** The surfaces to render, in creation order. */
  get surfaces(): SurfaceModel[] {
    return [...this.processor.model.surfacesMap.values()];
  }

  /** The board surface, once the agent has created it. */
  get boardSurface(): SurfaceModel | undefined {
    return this.processor.model.getSurface(KANBAN_SURFACE_ID);
  }

  /** Records a literal A2A message exchanged with the agent; see {@link A2aTrafficListener}. */
  recordA2aMessage(direction: A2aDirection, message: Record<string, unknown>): void {
    (direction === 'host-to-agent' ? this.hostToAgentMessages : this.agentToHostMessages).push(
      message,
    );
    this.notify();
  }

  /** Records a literal MCP JSON-RPC message sent from the host to the MCP App. */
  recordHostToMcpMessage(message: Record<string, unknown>): void {
    this.hostToMcpMessages.push(message);
    this.notify();
  }

  /** Records a literal MCP JSON-RPC message sent from the MCP App to the host. */
  recordMcpToHostMessage(message: Record<string, unknown>): void {
    this.mcpToHostMessages.push(message);
    this.notify();
  }

  /** Clears all recorded debug protocol messages across all streams. */
  clearDebugMessages(): void {
    this.hostToAgentMessages.length = 0;
    this.agentToHostMessages.length = 0;
    this.a2uiMessages.length = 0;
    this.hostToMcpMessages.length = 0;
    this.mcpToHostMessages.length = 0;
    this.notify();
  }

  /**
   * Captures `postMessage` traffic in both directions between `hostWindow` and
   * embedded MCP App sandbox frames. Returns a cleanup function.
   */
  attachMcpFrameDebugger(hostWindow: Window = window): () => void {
    const cleanups = new Set<() => void>();
    const onHostSend = (payload: Record<string, unknown>) => {
      this.recordHostToMcpMessage(payload);
    };
    const onWindowMessage = (event: MessageEvent) => {
      if (!event.source || event.source === hostWindow) {
        return;
      }
      const sourceWindow = event.source as Window;
      cleanups.add(attachPostMessageInterceptor(sourceWindow, onHostSend));
      if (isMcpJsonRpcMessage(event.data)) {
        this.recordMcpToHostMessage(event.data);
      }
    };
    hostWindow.addEventListener('message', onWindowMessage, true);
    return () => {
      hostWindow.removeEventListener('message', onWindowMessage, true);
      for (const cleanup of cleanups) {
        cleanup();
      }
      cleanups.clear();
    };
  }

  /** Sends what the user typed. */
  async sendUserText(text: string): Promise<void> {
    const trimmed = text.trim();
    if (trimmed === '') {
      return;
    }
    this.push('user', trimmed);
    await this.sendTurn([{kind: 'text', text: trimmed}]);
  }

  /**
   * Handles an action from any surface. `a2ui.mcpAppMessage` is the board app
   * talking to the agent (channel D): its text becomes a user turn, and the
   * action itself travels along as an A2UI `action` message, so the agent
   * also sees the structured event in the text block's `_meta`.
   */
  async handleAction(action: ActionPayload): Promise<void> {
    if (action.name !== MCP_APP_MESSAGE_ACTION) {
      this.push('system', `Action ${action.name} from ${action.sourceComponentId}`);
      return;
    }
    const text = messageText(action.context['content']);
    this.push('user', text === '' ? '(message from the board app)' : text);
    const parts: Part[] = [];
    if (text !== '') {
      parts.push({kind: 'text', text});
    }
    parts.push(
      a2uiDataPart({
        version: 'v1.0',
        action: {
          name: action.name,
          surfaceId: action.surfaceId,
          sourceComponentId: action.sourceComponentId,
          timestamp: action.timestamp,
          context: action.context,
        },
      }),
    );
    await this.sendTurn(parts);
  }

  /**
   * The renderer data model that accompanies every turn (channel B): the
   * surface data model without the board itself, which the agent reads with
   * `list_board`, and without the raw tool result.
   */
  rendererDataModel(): Record<string, unknown> | null {
    const surface = this.boardSurface;
    if (!surface) {
      return null;
    }
    const kanban = surface.dataModel.get<Record<string, unknown> | undefined>('/kanban');
    if (!kanban || typeof kanban !== 'object' || Array.isArray(kanban)) {
      return null;
    }
    const trimmed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(kanban)) {
      if (!OMITTED_DATA_MODEL_KEYS.has(key)) {
        trimmed[key] = value;
      }
    }
    return {version: 'v1.0', surfaces: {[KANBAN_SURFACE_ID]: {kanban: trimmed}}};
  }

  /** The board as the host currently has it, for the UI status line. */
  currentBoard(): unknown {
    return this.boardSurface?.dataModel.get(BOARD_PATH);
  }

  private async sendTurn(parts: Part[]): Promise<void> {
    const dataModel = this.rendererDataModel();
    if (dataModel) {
      parts.push(a2uiDataPart(dataModel));
    }
    this.busy = true;
    this.notify();
    try {
      const reply = await this.options.agent.send(parts);
      this.applyReply(reply);
    } catch (error) {
      this.push('system', `Agent error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busy = false;
      this.notify();
    }
  }

  private applyReply(reply: AgentReply): void {
    if (reply.a2uiMessages.length > 0) {
      this.a2uiMessages.push(...reply.a2uiMessages);
      this.processor.processMessages(reply.a2uiMessages);
    }
    for (const text of reply.texts) {
      this.push('agent', text);
    }
    this.notify();
  }

  private push(role: ChatEntry['role'], text: string): void {
    this.entries.push({role, text});
    this.notify();
  }

  private notify(): void {
    this.options.onChange?.();
  }
}

/** Joins the text blocks of a `ui/message` content array. */
export function messageText(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .map(block =>
      block && typeof block === 'object' && (block as MessageContentBlock).type === 'text'
        ? String((block as MessageContentBlock).text ?? '')
        : '',
    )
    .filter(text => text !== '')
    .join('\n');
}

/** Connects one MCP client lazily and hands it to every tool the app calls. */
export function singleServerResolver(connect: () => Promise<McpToolClient>): McpClientResolver {
  let client: Promise<McpToolClient> | null = null;
  return () => {
    client ??= connect().catch(error => {
      client = null;
      throw error;
    });
    return client;
  };
}
