import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * cap-context-images
 *
 * Outbound provider-request guard for long image-heavy sessions.
 * Keeps the most recent image block(s) so immediate visual work still works,
 * but replaces older image/base64 blocks with tiny text placeholders before the
 * request leaves pi. This prevents OpenAI/Codex WebSocket 1009 "message too big"
 * and provider "invalid image data" failures caused by replaying old screenshots
 * or generated images on every turn.
 *
 * On-disk session JSONL is not modified by this extension.
 */
const KEEP_IMAGES = 1;
const PLACEHOLDER =
  "[older image omitted from provider payload by cap-context-images to prevent request-too-big/invalid-image failures]";

type JsonObject = Record<string, unknown>;

function clonePayload<T>(payload: T): T {
  if (typeof structuredClone === "function") return structuredClone(payload);
  return JSON.parse(JSON.stringify(payload)) as T;
}

function isImageBlock(obj: JsonObject): boolean {
  return obj.type === "image" || obj.type === "image_url" || obj.type === "input_image";
}

function textBlockTypeFor(obj: JsonObject): "text" | "input_text" {
  // OpenAI Responses payloads use input_text/input_image; Anthropic/chat-style
  // payloads use text/image or text/image_url. Preserve the surrounding schema.
  return obj.type === "input_image" ? "input_text" : "text";
}

function neutralize(obj: JsonObject): void {
  const textType = textBlockTypeFor(obj);
  for (const key of Object.keys(obj)) delete obj[key];
  obj.type = textType;
  obj.text = PLACEHOLDER;
}

export default function (pi: ExtensionAPI) {
  pi.on("before_provider_request", (event) => {
    const root = clonePayload(event.payload) as JsonObject;
    const imageBlocks: JsonObject[] = [];

    const visit = (value: unknown): void => {
      if (!value || typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      const obj = value as JsonObject;
      if (isImageBlock(obj)) imageBlocks.push(obj);
      for (const item of Object.values(obj)) visit(item);
    };

    visit(root);
    if (imageBlocks.length <= KEEP_IMAGES) return undefined;

    const cutoff = imageBlocks.length - KEEP_IMAGES;
    for (let i = 0; i < cutoff; i++) neutralize(imageBlocks[i]);

    return root;
  });
}
