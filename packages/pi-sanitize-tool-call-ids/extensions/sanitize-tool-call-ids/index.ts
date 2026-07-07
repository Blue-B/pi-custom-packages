import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;

const VALID_TOOL_ID = /^[a-zA-Z0-9_-]+$/;

function sanitizeToolId(id: string): string {
  const base = id.includes("|") ? id.split("|", 1)[0] : id;
  const sanitized = base.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return sanitized || "tool_call";
}

function hasInvalidToolId(id: unknown): id is string {
  return typeof id === "string" && !VALID_TOOL_ID.test(id);
}

function clonePayload<T>(payload: T): T {
  if (typeof structuredClone === "function") return structuredClone(payload);
  return JSON.parse(JSON.stringify(payload)) as T;
}

function rewritePayload(payload: unknown): { payload: unknown; changed: boolean } {
  const root = clonePayload(payload);
  const idMap = new Map<string, string>();
  let changed = false;

  const normalize = (id: string): string => {
    const existing = idMap.get(id);
    if (existing) return existing;
    const next = sanitizeToolId(id);
    idMap.set(id, next);
    if (next !== id) changed = true;
    return next;
  };

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }

    const obj = value as JsonObject;

    // OpenAI Chat Completions format: assistant.tool_calls[].id
    if (Array.isArray(obj.tool_calls)) {
      for (const toolCall of obj.tool_calls) {
        if (toolCall && typeof toolCall === "object") {
          const tc = toolCall as JsonObject;
          if (hasInvalidToolId(tc.id)) tc.id = normalize(tc.id);
        }
      }
    }

    // OpenAI Chat Completions tool result format: { role: "tool", tool_call_id }
    if (hasInvalidToolId(obj.tool_call_id)) obj.tool_call_id = normalize(obj.tool_call_id);

    // Anthropic format: content blocks { type: "tool_use", id } and { type: "tool_result", tool_use_id }
    if (obj.type === "tool_use" && hasInvalidToolId(obj.id)) obj.id = normalize(obj.id);
    if (obj.type === "tool_result" && hasInvalidToolId(obj.tool_use_id)) obj.tool_use_id = normalize(obj.tool_use_id);

    for (const item of Object.values(obj)) visit(item);
  };

  visit(root);
  return { payload: root, changed };
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) => {
    const result = rewritePayload(event.payload);
    return result.changed ? result.payload : undefined;
  });
}
