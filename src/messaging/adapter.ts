/**
 * MessagingAdapter — platform-neutral interface every chat platform must
 * implement so that Jarvis's agent, tools, /research executor, and synthesizer
 * can run unchanged on Telegram, Slack, WhatsApp, or any other platform.
 *
 * Introduced in v1.8.1 as part of the gateway-platform decoupling. Before
 * this, the type was called `TelegramAdapter` and lived in src/gateway/.
 * src/gateway/telegramAdapter.ts is kept for one release as a thin
 * re-export shim so existing imports don't break.
 *
 * Porting to a new platform is a matter of implementing this interface
 * against the platform's SDK. See docs in src/messaging/telegram.ts for
 * the reference implementation.
 */

/**
 * Universal (every platform supports these):
 *   - sendMessage / editMessageText — text posts + in-place edits
 *   - sendDocument — file upload as a document/attachment
 *   - sendPhoto — image with optional caption
 *
 * Best-effort (platform support varies):
 *   - sendVoice — native voice note. Telegram & WhatsApp yes. Slack: upload
 *     as an audio file (no "voice note" concept); implementers may alias to
 *     sendDocument for the audio file.
 *   - inline keyboard buttons (`buttons` opt on sendMessage/editMessageText):
 *     Telegram native; Slack has Block Kit buttons (translated); WhatsApp
 *     has "interactive buttons" but only 3 max per message.
 *   - sendChatAction — Telegram shows "typing…" etc.; Slack has similar
 *     via chat.postEphemeral; WhatsApp has no equivalent (no-op there).
 *
 * Platform-specific niceties that leak through for now:
 *   - parseMode — Telegram accepts 'HTML' | 'Markdown' | 'MarkdownV2'. Slack
 *     and WhatsApp have their own formatting (Slack mrkdwn; WhatsApp
 *     WhatsApp-flavored markdown). Implementers MUST translate — e.g.,
 *     strip HTML tags for Slack, convert to blocks, etc. Long-term this
 *     should move to a `format: 'plain' | 'markdown' | 'html'` abstraction,
 *     tracked in TODO.md under Platform Ports → Refactor.
 */

/**
 * A single tappable button. `data` is a short string (≤64 bytes on
 * Telegram) that the gateway sees back as `callback_query.data`.
 * Convention: "<action>:<plan_id>" e.g. "plan.cancel:pl_abc123".
 */
export interface InlineButton {
  label: string;
  data: string;
}

/** 2D layout: outer array = rows, inner array = buttons in that row. */
export type InlineKeyboard = InlineButton[][];

export interface MessagingAdapter {
  /**
   * Send a text message. Returns the platform-assigned message id so callers
   * can later edit it in place (used by the /research progress panel).
   * `buttons` attaches a tappable inline keyboard below the text.
   */
  sendMessage(
    chatId: number,
    text: string,
    opts?: {
      parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
      buttons?: InlineKeyboard;
    },
  ): Promise<{ messageId: number }>;

  /**
   * Edit the text of a previously-sent message.
   * Telegram: silently rejects edits when new text is identical; caller must dedupe.
   * Slack:    chat.update is forgiving.
   * WhatsApp: only works within 15 minutes of the original send.
   * `buttons` replaces the inline keyboard (pass [] to clear, omit to keep as-is).
   */
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    opts?: {
      parseMode?: 'HTML' | 'Markdown' | 'MarkdownV2';
      buttons?: InlineKeyboard;
    },
  ): Promise<void>;

  /** Upload a local file as a document/attachment. Used for REPORT.md delivery. */
  sendDocument(
    chatId: number,
    path: string,
    opts?: { caption?: string; disableContentTypeDetection?: boolean },
  ): Promise<{ messageId: number }>;

  /** Send an image with optional caption. */
  sendPhoto(
    chatId: number,
    path: string,
    opts?: { caption?: string },
  ): Promise<{ messageId: number }>;

  /**
   * Send a voice note. Native on Telegram/WhatsApp. Slack implementers may
   * fall back to sendDocument for the .ogg/.opus file.
   */
  sendVoice(
    chatId: number,
    path: string,
    opts?: { caption?: string },
  ): Promise<{ messageId: number }>;

  /**
   * Show a transient activity indicator ("Jarvis is typing…" /
   * "uploading photo…" / etc.) so the user sees liveness while the bot is
   * working silently between panel edits. On Telegram the indicator fades
   * after ~5s on its own — call again every 4s to keep it visible.
   *
   * Fire-and-forget: swallows errors since this is purely cosmetic and a
   * failed chat-action must never kill a turn.
   *
   * Action vocabulary (Telegram-native; Slack/WhatsApp will translate or no-op):
   *   'typing'         — default for text work
   *   'upload_photo'   — sending an image
   *   'upload_document'— sending a file
   *   'record_voice'   — generating a TTS reply
   *   'upload_voice'   — sending the TTS reply
   */
  sendChatAction(
    chatId: number,
    action:
      | 'typing'
      | 'upload_photo'
      | 'upload_document'
      | 'record_voice'
      | 'upload_voice',
  ): Promise<void>;

  /**
   * Resolve the DM chat id for a given userId.
   * On Telegram: returns userId (DM chatId === userId).
   * On Slack/WhatsApp (future): look up the platform-specific DM channel id.
   * Returns null when no DM channel is available for this user.
   * Added v1.9.0 for platform-neutral reminder delivery (CP1 R10).
   */
  resolveDmChatId(userId: number): number | null;

  /**
   * v1.12.0 — replace only the inline keyboard of a previously-sent message.
   * Pass `undefined` to clear the keyboard entirely (common usage: stripping
   * buttons off a terminal or expired panel).
   * Telegram: thin wrapper over bot.api.editMessageReplyMarkup.
   * Slack / WhatsApp (future): map to the platform's native equivalent.
   */
  editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    buttons: InlineKeyboard | undefined,
  ): Promise<void>;

  /**
   * v1.13.0 — Send a message with an inline button that opens a Telegram Web App.
   *
   * The URL MUST be HTTPS — Telegram rejects http:// URLs in web_app buttons.
   * Implementations should validate this at the adapter level and throw a
   * typed error rather than silently failing at the platform layer.
   *
   * Telegram: builds an InlineKeyboard with a single button carrying
   * `web_app: { url }` (grammY's `InlineKeyboard.webApp(label, url)`).
   *
   * Slack/WhatsApp (future): unsupported. Implementations fall back to
   * sendMessage with the URL inline as text + a warning log; they MAY
   * throw a typed `WebAppButtonUnsupportedError` if the caller prefers.
   */
  sendWebAppButton(
    chatId: number,
    text: string,
    buttonLabel: string,
    url: string,
  ): Promise<{ messageId: number }>;
}
