/**
 * wechat-event-listener — pi extension
 *
 * Connects to the wechat-bro WebSocket server (default ws://localhost:9231,
 * override with WECHAT_BRO_WS) and forwards each `message*` event to the
 * agent as a user message — verbatim JSON, no formatting.
 *
 * Default state: OFF. The agent must call the `setup_wechat_listener` tool
 * to enable this process's listener, e.g. at startup:
 *
 *     setup_wechat_listener({ enable: true, filter: "李三" })
 *
 * - `filter`: comma-separated contact/room names matched against the
 *   conversation partner on either side — `data.from` for incoming messages
 *   (for room messages this is the room name), `data.to` for outgoing ones
 *   (when `data.from` is self, `"me"`). Empty = forward all messages.
 *   Handles `from`/`to` as a plain name string OR a contact object
 *   ({name, DisplayName, NickName}). Agents use the canonical name
 *   `filehelper` for the File Transfer Helper.
 * - `learn` (default false): when true, the account owner's OWN outgoing
 *   messages (from = "me"; in rooms sender = "me") that match the filter are
 *   saved into THIS session's transcript as a `wechat-owner-message` custom
 *   entry — they do NOT wake the LLM, but appear in its context on the next
 *   turn, so the model can learn from the owner. Incoming contact messages
 *   are always delivered.
 * - `assistant` (default false): when true, the LLM replies as the assistant
 *   bot named `$$` instead of on behalf of the account owner. Forwarded
 *   messages carry `asksAssistant: true` when the content mentions @$$
 *   (or the resolved mentions include it) — i.e. the message is directly
 *   asking the assistant. The assistant name is fixed and not configurable.
 * - Auto-reconnect + notifications: the socket reconnects every 3s after a
 *   drop, and the agent is notified on connection loss / restore. Subagents
 *   do NOT need to re-enable after a daemon restart — the filter survives in
 *   this process's state.
 * - `enable: false`: disconnect the socket and clear the filter.
 * - Env seed (optional): WECHAT_BRO_FILTER_CONTACT=name1,name2 auto-enables
 *   the listener at load with that filter — handy for standalone launches
 *   like `WECHAT_BRO_FILTER_CONTACT=alice pi`.
 *
 * @param {import("@earendil-works/pi-coding-agent").ExtensionAPI} pi
 */
export default function (pi) {
  const url = process.env.WECHAT_BRO_WS || "ws://localhost:9231";
  // Assistant bot name — fixed, not configurable.
  const ASSISTANT_NAME = "$$";
  const envSeed = (process.env.WECHAT_BRO_FILTER_CONTACT || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let filterContacts = envSeed;
  let enabled = envSeed.length > 0; // env seed = auto-enable at load
  let learnMode = false;
  let assistantMode = false;
  let ws = null;
  let retry = null;
  let wasConnected = false;

  function notify(text) {
    try {
      pi.sendUserMessage(`[wechat-event-listener] ${text}`, {
        deliverAs: "followUp",
      });
    } catch (e) {
      /* ignore */
    }
  }

  function parseContacts(raw) {
    return (raw || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /** Candidate names for a message party — the display name(s) from the
   *  contact object or a plain name string. No special cases. */
  function contactNames(c) {
    if (!c) return [];
    if (typeof c === "string") return [c];
    if (typeof c === "object") {
      return [...new Set([c.name, c.DisplayName, c.NickName].filter(Boolean))];
    }
    return [];
  }

  function passesFilter(msg) {
    if (!filterContacts.length) return true;
    const data = msg.data || {};
    const matches = (party) =>
      contactNames(party).some((n) => filterContacts.includes(n));
    // Match the watched contact on either side of the conversation:
    // - incoming: data.from is the contact (rooms: the room name)
    // - outgoing (from = "me"): data.to is the contact/room we messaged
    return matches(data.from) || matches(data.to);
  }

  /** True when the account owner is the actual sender. DM: from = "me".
   *  Room: from is the ROOM name, the member is in sender — so check both. */
  function isOwnerSent(data) {
    return (
      contactNames(data.from).includes("me") ||
      contactNames(data.sender).includes("me")
    );
  }

  /** True when the message explicitly addresses the assistant bot
   *  (content contains @<name> / @"<name>", or resolved mentions include it). */
  function hasAssistantMention(data, name) {
    if (!name) return false;
    const content = typeof data.Content === "string" ? data.Content : "";
    if (content.includes("@" + name) || content.includes('@"' + name + '"')) {
      return true;
    }
    return Array.isArray(data.mentions) && data.mentions.includes(name);
  }

  /** Save the owner's outgoing message into THIS session's transcript as a
   *  custom entry (persists to the session jsonl, participates in LLM context)
   *  without waking the model — so the LLM can learn from the owner later. */
  function learnOwnerMessage(msg, asksAssistant) {
    try {
      pi.sendMessage({
        customType: "wechat-owner-message",
        content: JSON.stringify(msg),
        display: false,
        details: {
          event: msg.event,
          from: "me",
          to: (msg.data && contactNames(msg.data.to)[0]) || undefined,
          sender:
            msg.data && msg.data.sender
              ? contactNames(msg.data.sender)[0]
              : undefined,
          asksAssistant,
        },
      }); // idle: appends to session jsonl + state, no turn
      console.error(
        "[wechat-event-listener] owner message saved to session (customType=wechat-owner-message)"
      );
    } catch (e) {
      console.error("[wechat-event-listener] save to session failed:", e.message);
    }
  }

  function connect() {
    const WS = globalThis.WebSocket;
    if (!WS) return;
    try {
      ws = new WS(url);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      console.error("[wechat-event-listener] connected to", url);
      if (!wasConnected) {
        wasConnected = true;
        notify(`connected to wechat-bro (${url})`);
      }
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!msg.event || !msg.event.startsWith("message:")) return;
      if (!passesFilter(msg)) return;
      const data = msg.data || {};
      // Flag direct calls to the assistant bot (@<name> in content).
      const asksAssistant = hasAssistantMention(data, ASSISTANT_NAME);
      // Owner's own outgoing message (DM: from="me"; room: sender="me",
      // since from is the room name): learn it (if enabled) instead of waking.
      if (isOwnerSent(data)) {
        if (learnMode) learnOwnerMessage(msg, asksAssistant);
        else {
          msg.asksAssistant = asksAssistant;
          pi.sendUserMessage(JSON.stringify(msg), { deliverAs: "followUp" });
        }
        return;
      }
      msg.asksAssistant = asksAssistant;
      pi.sendUserMessage(JSON.stringify(msg), { deliverAs: "followUp" });
    };
    ws.onclose = () => {
      ws = null;
      if (wasConnected) {
        wasConnected = false;
        notify(`lost connection to wechat-bro, retrying every 3s`);
      }
      schedule();
    };
  }

  function schedule() {
    if (retry) return;
    retry = setTimeout(() => {
      retry = null;
      connect();
    }, 3000);
  }

  function disconnect() {
    if (retry) {
      clearTimeout(retry);
      retry = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {}
      ws = null;
    }
  }

  // Turn the listener on/off for THIS process. Off by default — the agent
  // enables it when it wants to receive a contact's messages.
  pi.registerTool({
    name: "setup_wechat_listener",
    label: "Setup WeChat listener",
    description:
      "Enable/disable this session's WeChat event listener (off by default). " +
      "Call with enable:true and your assigned contact/room name at startup to receive that contact's messages only. " +
      "learn:true stores the account owner's own outgoing messages in a session log instead of waking you. " +
      "assistant:true makes you reply as an assistant bot instead of on behalf of the account owner.",
    promptSnippet:
      "Call setup_wechat_listener({enable:true, filter:'<your contact>', learn:true, assistant:true}) at startup.",
    promptGuidelines: [
      "The WeChat listener is OFF by default. Enable it with setup_wechat_listener({enable:true, filter:'<contact>'}) to start receiving messages.",
      "learn:true saves the owner's outgoing messages into THIS session as wechat-owner-message entries instead of delivering them — they appear in your context on the next turn.",
      "assistant:true = reply as an assistant bot, not as the account owner.",
      "setup_wechat_listener({enable:false}) disconnects the listener.",
    ],
    parameters: {
      type: "object",
      properties: {
        enable: {
          type: "boolean",
          description: "true = turn the listener on (connect + forward), false = turn it off",
        },
        filter: {
          type: "string",
          description:
            "Comma-separated contact/room names to forward. Matched against the conversation partner on either side (data.from for incoming, data.to for outgoing), or empty string for all messages",
        },
        learn: {
          type: "boolean",
          description:
            "true = the account owner's own outgoing messages that match the filter are saved into this session's transcript as a wechat-owner-message entry instead of being delivered as user messages (so you can learn from them on the next turn)",
        },
        assistant: {
          type: "boolean",
          description:
            "true = reply as an assistant bot (named $$) instead of on behalf of the account owner",
        },
      },
      required: ["enable"],
    },
    execute: async (toolCallId, params) => {
      if (params.enable === false) {
        filterContacts = [];
        enabled = false;
        learnMode = false;
        assistantMode = false;
        disconnect();
        console.error("[wechat-event-listener] disabled");
        return {
          content: [{ type: "text", text: "Listener off." }],
          details: { enabled: false, filter: [] },
        };
      }
      filterContacts = parseContacts(params.filter);
      learnMode = params.learn === true;
      assistantMode = params.assistant === true;
      enabled = true;
      if (!ws) connect();
      const mode = [
        learnMode ? "learn" : null,
        assistantMode ? `assistant(${ASSISTANT_NAME})` : null,
      ]
        .filter(Boolean)
        .join(" + ");
      console.error(
        "[wechat-event-listener] enabled, filter:",
        filterContacts.length ? filterContacts.join(", ") : "(all)",
        mode ? `, mode: ${mode}` : ""
      );
      return {
        content: [
          {
            type: "text",
            text:
              (filterContacts.length
                ? `Listener on — forwarding messages from: ${filterContacts.join(", ")}. `
                : "Listener on — forwarding all messages. ") +
              (learnMode
                ? "Learn mode: your own outgoing messages are saved to this session (wechat-owner-message), not delivered. "
                : "") +
              (assistantMode
                ? `Assistant mode: reply as 「${ASSISTANT_NAME}」, not as the account owner.`
                : "Reply as the account owner."),
          },
        ],
        details: {
          enabled: true,
          filter: filterContacts,
          learn: learnMode,
          assistant: assistantMode,
          assistantName: ASSISTANT_NAME,
        },
      };
    },
  });

  // Connect at load only when auto-enabled by the env seed.
  if (enabled) connect();

  pi.on("session_shutdown", () => disconnect());
}
