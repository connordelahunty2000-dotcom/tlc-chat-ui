// app/(chat)/api/chat/route.ts
import { JsonToSseTransformStream, createUIMessageStream } from "ai";
import { auth, type UserType } from "@/app/(auth)/auth";
import { entitlementsByUserType } from "@/lib/ai/entitlements";
import { ChatSDKError } from "@/lib/errors";
import { convertToUIMessages, generateUUID } from "@/lib/utils";
import {
  getMessagesByChatId,
  getMessageCountByUserId,
  getChatById,
  saveChat,
  saveMessages,
} from "@/lib/db/queries";
import type { ChatMessage } from "@/lib/types";
import type { VisibilityType } from "@/components/visibility-selector";
import type { ChatModel } from "@/lib/ai/models";
import { type PostRequestBody, postRequestBodySchema } from "./schema";

export const maxDuration = 60;

// Safely finish the writer across SDK versions.
function finishWriter(writer: unknown) {
  const w = writer as any;
  if (w?.end && typeof w.end === "function") return w.end();
  if (w?.close && typeof w.close === "function") return w.close();
  if (w?.finish && typeof w.finish === "function") return w.finish();
}

// Deterministic title (no AI) that tolerates part shape differences.
function makeTitleFromMessage(msg: ChatMessage, fallback = "New chat") {
  try {
    const parts: any[] = (msg as any)?.parts ?? [];
    let firstText: string | undefined;

    for (const p of parts) {
      if (p && typeof p === "object") {
        if (p.type === "text" && typeof p.text === "string") {
          firstText = p.text;
          break;
        }
        if (p.type === "input_text" && typeof p.input_text === "string") {
          firstText = p.input_text;
          break;
        }
      } else if (typeof p === "string") {
        firstText = p;
        break;
      }
    }

    if (!firstText) firstText = String(parts[0] ?? "");
    if (!firstText) return fallback;

    const words = firstText.trim().split(/\s+/).slice(0, 8).join(" ");
    const clipped = words.length > 80 ? words.slice(0, 80) : words;
    return clipped || fallback;
  } catch {
    return fallback;
  }
}

export async function POST(request: Request) {
  // 1) Parse body
  let body: PostRequestBody;
  try {
    body = postRequestBodySchema.parse(await request.json());
  } catch {
    return new ChatSDKError("bad_request:api").toResponse();
  }

  const {
    id,
    message,
    selectedChatModel,
    selectedVisibilityType,
  }: {
    id: string;
    message: ChatMessage;
    selectedChatModel: ChatModel["id"];
    selectedVisibilityType: VisibilityType;
  } = body;

  // 2) Auth
  const session = await auth();
  if (!session?.user) return new ChatSDKError("unauthorized:chat").toResponse();

  // 3) Simple rate limit
  const userType: UserType = session.user.type;
  const messageCount = await getMessageCountByUserId({
    id: session.user.id,
    differenceInHours: 24,
  });
  if (messageCount > entitlementsByUserType[userType].maxMessagesPerDay) {
    return new ChatSDKError("rate_limit:chat").toResponse();
  }

  // 4) Ensure chat exists
  const chat = await getChatById({ id });
  if (chat && chat.userId !== session.user.id) {
    return new ChatSDKError("forbidden:chat").toResponse();
  }
  if (!chat) {
    await saveChat({
      id,
      userId: session.user.id,
      title: makeTitleFromMessage(message),
      visibility: selectedVisibilityType,
    });
  }

  // 5) Build history + persist the user message
  const uiHistory = [
    ...convertToUIMessages(await getMessagesByChatId({ id })),
    message,
  ];
  await saveMessages({
    messages: [
      {
        chatId: id,
        id: message.id,
        role: "user",
        parts: message.parts,
        attachments: [],
        createdAt: new Date(),
      },
    ],
  });

  // 6) Validate webhook env
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("Missing N8N_WEBHOOK_URL");
    return new ChatSDKError("offline:chat").toResponse();
  }

  // 7) Stream back to UI
  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const msgId = generateUUID();

      // Start a new assistant text stream
      writer.write({ type: "text-start", id: msgId });

      let assistantText = "";

      try {
        const res = await fetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(process.env.N8N_WEBHOOK_TOKEN
              ? { Authorization: `Bearer ${process.env.N8N_WEBHOOK_TOKEN}` }
              : {}),
          },
          body: JSON.stringify({
            chatId: id,
            model: selectedChatModel,
            message,
            history: uiHistory,
            user: session.user,
          }),
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => "");
          assistantText =
            errText ||
            `Sorry — the agent returned ${res.status} ${res.statusText}.`;
        } else {
          const ct = res.headers.get("content-type") || "";
          if (ct.includes("application/json")) {
            const data: any = await res.json().catch(() => ({}));
            assistantText =
              String(
                data.output ??
                  data.answer ??
                  data.text ??
                  data.message ??
                  data.result ??
                  ""
              ) || JSON.stringify(data);
          } else {
            assistantText = await res.text();
          }
        }

        if (!assistantText) {
          assistantText = "I didn’t receive a reply from the agent.";
        }

        writer.write({ type: "text-delta", delta: assistantText, id: msgId });
        writer.write({ type: "text-end", id: msgId });
        finishWriter(writer);

        // Persist assistant message
        await saveMessages({
          messages: [
            {
              chatId: id,
              id: generateUUID(),
              role: "assistant",
              parts: [{ type: "text", text: assistantText } as any],
              attachments: [],
              createdAt: new Date(),
            },
          ],
        });
      } catch (e) {
        console.error("n8n fetch failed:", e);
        assistantText = "Sorry — I couldn’t reach the agent right now.";
        writer.write({ type: "text-delta", delta: assistantText, id: msgId });
        writer.write({ type: "text-end", id: msgId });
        finishWriter(writer);

        await saveMessages({
          messages: [
            {
              chatId: id,
              id: generateUUID(),
              role: "assistant",
              parts: [{ type: "text", text: assistantText } as any],
              attachments: [],
              createdAt: new Date(),
            },
          ],
        });
      }
    },
  });

  return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
}
