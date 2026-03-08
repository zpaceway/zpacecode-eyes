import { useState, useRef, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
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

const protocol =
  import.meta.env.VITE_APP_BACKEND_PROTOCOL ||
  window.location.protocol === "https:"
    ? "wss"
    : "ws";
const host = import.meta.env.VITE_APP_BACKEND_HOST || window.location.host;
const WS_URL = `${protocol}://${host}/ws/agent/run/`;
console.log("WebSocket URL:", WS_URL);
const STORAGE_KEY = "eyes_conversations";
const ACTIVE_KEY = "eyes_active_id";

function loadConversations(): {
  conversations: Conversation[];
  activeId: string;
} {
  try {
    const messagesJSON = localStorage.getItem(STORAGE_KEY);
    if (messagesJSON) {
      const convs: Conversation[] = JSON.parse(messagesJSON);
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
}

const initial = loadConversations();

const App = () => {
  const [conversations, setConversations] = useState<Conversation[]>(
    initial.conversations,
  );
  const [activeId, setActiveId] = useState<string | null>(initial.activeId);
  const [input, setInput] = useState("");
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const loading = activeId ? loadingIds.has(activeId) : false;

  useEffect(() => {
    let shouldReconnect = true;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.error) return;

        const { conversation_id, messages, completed } = data;

        if (messages) {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conversation_id
                ? { ...c, messages: messages as Message[] }
                : c,
            ),
          );
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
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    if (activeId) localStorage.setItem(ACTIVE_KEY, activeId);
  }, [activeId]);

  const createConversation = useCallback(() => {
    const id = crypto.randomUUID();
    const conv: Conversation = {
      id,
      title: "New chat",
      messages: [],
    };
    setConversations((prev) => [...prev, conv]);
    setActiveId(id);
    setInput("");
  }, []);

  const closeConversation = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const next = prev.filter((c) => c.id !== id);
        if (next.length === 0) {
          const newId = crypto.randomUUID();
          setActiveId(newId);
          return [
            {
              id: newId,
              title: "New chat",
              messages: [],
            },
          ];
        }
        if (activeId === id) setActiveId(next[next.length - 1]?.id ?? null);
        return next;
      });
    },
    [activeId],
  );

  const send = useCallback(() => {
    if (!input.trim() || !activeId || loadingIds.has(activeId)) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const content = input.trim();
    setInput("");

    let messages: Message[] = [];

    setConversations((prev) =>
      prev.map((c) => {
        if (c.id !== activeId) return c;
        messages = [
          ...c.messages,
          { id: crypto.randomUUID(), role: "user", content },
        ];
        const isFirst = !c.messages.some((m) => m.role === "user");
        return {
          ...c,
          title: isFirst ? content.slice(0, 40) : c.title,
          messages: messages,
        };
      }),
    );

    setLoadingIds((prev) => new Set(prev).add(activeId));

    // Send after state update via microtask to ensure messages is populated
    queueMicrotask(() => {
      ws.send(
        JSON.stringify({
          type: "agent_run",
          messages: messages,
          conversation_id: activeId,
        }),
      );
    });
  }, [input, activeId, loadingIds]);

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      <div className="flex h-11 shrink-0 items-center border-b border-white/10">
        <div className="flex min-w-0 flex-1 items-center gap-0 overflow-x-auto">
          {conversations.map((c) => (
            <button
              key={c.id}
              onClick={() => setActiveId(c.id)}
              className={`group flex h-11 max-w-48 min-w-0 shrink-0 items-center gap-2 border-r border-white/10 px-3 text-left text-sm outline-none ${
                c.id === activeId
                  ? "bg-white/10 text-white"
                  : "text-white/50 hover:text-white/80"
              }`}
            >
              <span className="flex-1 truncate">{c.title}</span>
              <span
                onClick={(e) => {
                  e.stopPropagation();
                  closeConversation(c.id);
                }}
                className="shrink-0 text-white/30 hover:text-white"
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <button
          onClick={createConversation}
          className="flex h-11 w-11 shrink-0 items-center justify-center text-lg text-white/50 outline-none hover:text-white"
        >
          +
        </button>
      </div>

      <div className="flex flex-1 flex-col overflow-hidden">
        {active && (
          <>
            <div className="flex-1 overflow-y-auto">
              <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8">
                {active.messages
                  .filter(
                    (m) =>
                      (m.role === "user" || m.role === "assistant") &&
                      m.content,
                  )
                  .map((m, i) => (
                    <div
                      key={(m.id as string) ?? i}
                      className="flex flex-col gap-1"
                    >
                      <div className="text-xs font-medium text-white/40">
                        {m.role === "user" ? "You" : "Assistant"}
                      </div>
                      <div
                        className={`prose prose-sm prose-invert max-w-none ${
                          m.role === "user" ? "text-white" : "text-white/80"
                        }`}
                      >
                        <Markdown remarkPlugins={[remarkGfm]}>
                          {(m.content as string) ?? ""}
                        </Markdown>
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
            </div>

            <div className="shrink-0 border-t border-white/10 px-4 py-3">
              <div className="mx-auto flex max-w-2xl items-end gap-2">
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
                  className="min-w-0 flex-1 resize-none overflow-hidden rounded border border-white/20 bg-transparent px-3 py-2 text-sm text-white outline-none placeholder:text-white/30 focus:border-white/40 disabled:opacity-50"
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
          </>
        )}
      </div>
    </div>
  );
};

export default App;
