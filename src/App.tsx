import { useState, useRef, useEffect } from "react";
import Markdown from "react-markdown";
import { toast } from "react-toastify";
import remarkGfm from "remark-gfm";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type Conversation = {
  id: string;
  title: string;
  messages: Message[];
};

type Settings = {
  host: string;
  protocol: string;
  brainToken: string;
};

const STORAGE_KEY = "eyes_conversations";
const ACTIVE_KEY = "eyes_active_id";
const SETTINGS_KEY = "eyes_settings";

const defaultSettings: Settings = {
  host: import.meta.env.VITE_APP_BACKEND_HOST || window.location.host,
  protocol:
    import.meta.env.VITE_APP_BACKEND_PROTOCOL ||
    (window.location.protocol === "https:" ? "wss" : "ws"),
  brainToken: "",
};

const loadSettings = (): Settings => {
  try {
    const json = localStorage.getItem(SETTINGS_KEY);
    if (json) {
      const s = JSON.parse(json);
      return { ...defaultSettings, ...s };
    }
  } catch {
    /* ignore */
  }
  return { ...defaultSettings };
};

const loadConversations = (): {
  conversations: Conversation[];
  activeId: string;
} => {
  try {
    const messagesJSON = localStorage.getItem(STORAGE_KEY);
    if (messagesJSON) {
      const convs: Conversation[] = JSON.parse(messagesJSON).filter(
        (c: Conversation) =>
          c.id &&
          c.title &&
          Array.isArray(c.messages) &&
          c.messages.every((m) => m.id && m.role && m.content),
      );
      if (convs.length > 0) {
        const savedActive = localStorage.getItem(ACTIVE_KEY);
        const activeId =
          convs.find((c) => c.id === savedActive)?.id ??
          convs[convs.length - 1].id;
        return { conversations: convs, activeId };
      }
    }
  } catch {
    /* ignore corrupt data */
  }
  const id = crypto.randomUUID();
  return {
    conversations: [{ id, title: "New chat", messages: [] }],
    activeId: id,
  };
};

const initial = loadConversations();

const App = () => {
  const [conversations, setConversations] = useState<Conversation[]>(
    initial.conversations,
  );
  const [activeId, setActiveId] = useState<string>(initial.activeId);
  const [input, setInput] = useState("");
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [draftSettings, setDraftSettings] = useState<Settings>(settings);
  const [showSidebar, setShowSidebar] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const active =
    conversations.find((c) => c.id === activeId) ?? conversations[0];
  const loading = loadingIds.has(active.id);

  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    let shouldReconnect = true;

    const connect = () => {
      const { protocol, host } = settingsRef.current;
      const ws = new WebSocket(`${protocol}://${host}/ws/agent/run/`);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);

        if (data.type === "error") {
          const convId = data.conversation_id;
          if (convId) {
            toast.error(data.error);
            setLoadingIds((prev) => {
              const next = new Set(prev);
              next.delete(convId);
              return next;
            });
          }
          return;
        }

        const { conversation_id, messages, completed } = data;

        if (messages) {
          setConversations((prev) => {
            const exists = prev.some((c) => c.id === conversation_id);
            if (exists) {
              return prev.map((c) =>
                c.id === conversation_id
                  ? { ...c, messages: messages as Message[] }
                  : c,
              );
            }
            const title =
              (messages as Message[])
                .find((m: Message) => m.role === "user")
                ?.content.slice(0, 40) || "New chat";
            return [
              ...prev,
              {
                id: conversation_id,
                title,
                messages: messages as Message[],
              },
            ];
          });
        }

        if (completed) {
          setLoadingIds((prev) => {
            const next = new Set(prev);
            next.delete(conversation_id);
            return next;
          });
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (shouldReconnect) setTimeout(connect, 1000);
      };

      ws.onerror = () => {
        ws.close();
      };
    };

    connect();

    return () => {
      shouldReconnect = false;
      if (wsRef.current) {
        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.close();
        } else {
          wsRef.current.onopen = () => wsRef.current?.close();
        }
      }
    };
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [active.messages, loading]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_KEY, activeId);
  }, [activeId]);

  const createConversation = () => {
    const id = crypto.randomUUID();
    setConversations((prev) => [
      ...prev,
      { id, title: "New chat", messages: [] },
    ]);
    setActiveId(id);
    setInput("");
  };

  const closeConversation = (id: string) => {
    setConversations((prev) => {
      if (prev.length <= 1) {
        return prev.map((c) =>
          c.id === id ? { ...c, title: "New chat", messages: [] } : c,
        );
      }
      const next = prev.filter((c) => c.id !== id);
      if (activeId === id) setActiveId(next[next.length - 1].id);
      return next;
    });
  };

  const send = () => {
    if (!input.trim() || loadingIds.has(activeId)) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const content = input.trim();
    const current = conversations.find((c) => c.id === activeId);
    if (!current) return;

    const messages: Message[] = [
      ...current.messages,
      { id: crypto.randomUUID(), role: "user", content },
    ];
    const isFirst = !current.messages.some((m) => m.role === "user");

    setInput("");
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeId
          ? { ...c, title: isFirst ? content.slice(0, 40) : c.title, messages }
          : c,
      ),
    );
    setLoadingIds((prev) => new Set(prev).add(activeId));

    ws.send(
      JSON.stringify({
        type: "agent_run",
        messages,
        conversation_id: activeId,
        token: settingsRef.current.brainToken || undefined,
      }),
    );
  };

  return (
    <div className="fixed inset-0 flex bg-black text-white">
      {/* Sidebar backdrop (mobile only) */}
      {showSidebar && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setShowSidebar(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-white/10 bg-neutral-950 transition-transform md:static md:translate-x-0 ${
          showSidebar ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/10 px-3">
          <span className="text-sm font-medium text-white/60">Chats</span>
          <div className="flex items-center gap-1">
            <button
              onClick={createConversation}
              className="flex h-8 w-8 items-center justify-center rounded text-lg text-white/50 hover:bg-white/10 hover:text-white"
            >
              +
            </button>
            <button
              onClick={() => {
                setDraftSettings(settings);
                setShowSettings(true);
              }}
              className="flex h-8 w-8 items-center justify-center rounded text-white/50 hover:bg-white/10 hover:text-white"
              title="Settings"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setActiveId(c.id);
                setShowSidebar(false);
              }}
              className={`group flex w-full items-center gap-2 px-3 py-2 text-left text-sm outline-none ${
                c.id === activeId
                  ? "bg-white/10 text-white"
                  : "text-white/50 hover:bg-white/5 hover:text-white/80"
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  closeConversation(c.id);
                }}
                className="shrink-0 text-white/20 opacity-0 group-hover:opacity-100 hover:text-white"
              >
                ×
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Main content */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Mobile header */}
        <div className="flex h-11 shrink-0 items-center border-b border-white/10 px-3 md:hidden">
          <button
            onClick={() => setShowSidebar(true)}
            className="flex h-8 w-8 items-center justify-center rounded text-white/50 hover:bg-white/10 hover:text-white"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>
          <span className="ml-2 truncate text-sm text-white/60">
            {active.title}
          </span>
        </div>

        {showSettings && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
            onClick={() => setShowSettings(false)}
          >
            <div
              className="w-full max-w-md rounded-lg border border-white/10 bg-neutral-900 p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="mb-4 text-lg font-semibold">Settings</h2>
              <label className="mb-1 block text-sm text-white/60">
                Protocol
              </label>
              <select
                value={draftSettings.protocol}
                onChange={(e) =>
                  setDraftSettings((d) => ({ ...d, protocol: e.target.value }))
                }
                className="mb-3 w-full rounded border border-white/20 bg-transparent px-3 py-2 text-sm text-white outline-none focus:border-white/40"
              >
                <option value="ws" className="bg-neutral-900">
                  ws
                </option>
                <option value="wss" className="bg-neutral-900">
                  wss
                </option>
              </select>
              <label className="mb-1 block text-sm text-white/60">
                Backend Host
              </label>
              <input
                type="text"
                value={draftSettings.host}
                onChange={(e) =>
                  setDraftSettings((d) => ({ ...d, host: e.target.value }))
                }
                placeholder="e.g. localhost:8000"
                className="mb-3 w-full rounded border border-white/20 bg-transparent px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-white/40"
              />
              <label className="mb-1 block text-sm text-white/60">
                Brain Token
              </label>
              <input
                type="password"
                value={draftSettings.brainToken}
                onChange={(e) =>
                  setDraftSettings((d) => ({
                    ...d,
                    brainToken: e.target.value,
                  }))
                }
                placeholder="Brain token"
                className="mb-5 w-full rounded border border-white/20 bg-transparent px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-white/40"
              />
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowSettings(false)}
                  className="rounded px-4 py-2 text-sm text-white/60 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setSettings(draftSettings);
                    setShowSettings(false);
                  }}
                  className="rounded bg-white px-4 py-2 text-sm font-medium text-black hover:bg-white/90"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        )}

        {active && (
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="mx-auto flex max-w-2xl flex-col gap-2 pt-8 pb-32">
              {active.messages
                .filter(
                  (m) => m.content && ["user", "assistant"].includes(m.role),
                )
                .map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`flex flex-col gap-1 ${
                        m.role === "user" ? "items-end" : "items-start"
                      }`}
                    >
                      <div
                        className={`prose prose-sm prose-invert max-w-none rounded-lg px-4 py-2 ${
                          m.role === "user"
                            ? "bg-white/10 text-white"
                            : "text-white/80"
                        }`}
                      >
                        <Markdown remarkPlugins={[remarkGfm]}>
                          {m.content}
                        </Markdown>
                      </div>
                    </div>
                  </div>
                ))}
              {loading && (
                <div className="flex flex-col gap-1">
                  <div className="text-xs font-medium text-white/40">
                    Assistant
                  </div>
                  <div className="text-sm text-white/50">Thinking...</div>
                </div>
              )}
            </div>
            <div className="sticky bottom-0 flex justify-center bg-black px-4 pt-4 pb-4">
              <div className="flex w-full max-w-2xl items-end gap-2">
                <textarea
                  ref={textareaRef}
                  value={input}
                  rows={1}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder="Send a message..."
                  disabled={loading}
                  className="w-full min-w-0 resize-none overflow-hidden rounded border border-white/20 bg-transparent px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-white/40 disabled:opacity-50"
                />
                <button
                  onClick={send}
                  disabled={loading || !input.trim()}
                  className="rounded bg-white px-4 py-2 text-sm font-medium text-black transition outline-none hover:bg-white/90 focus-visible:ring-1 focus-visible:ring-white/30 disabled:opacity-30"
                >
                  Send
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
