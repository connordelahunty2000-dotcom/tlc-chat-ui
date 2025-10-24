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

// Finish the UI writer safely across SDK versions.
function finishWriter(writer: unknown) {
  const w = writer as any;
  if (w?.end && typeof w.end === "function") return w.end();
  if (w?.close && typeof w.close === "function") return w.close();
  if (w?.finish && typeof w.finish === "function") return w.finish();
}

// Make a simple title without AI
function makeTitleFromMessage(msg: ChatMessage, fallback = "New chat") {
  try {
    const firstText =
      msg?.parts?.find((p: any) => p?.type === "text")?.text ??
      (Array.isArray(msg?.parts) ? String(msg.parts[0] ?? "") : "");
    if (!firstText) return fallback;
    // take first ~8 words
    const words = firstText.trim().split(/\s+/).slice(0, 8).join(" ");
    return words.length > 80 ? words.slice(0, 80) : words || fallback;
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
    const title = makeTitleFromMessage(message);
    await saveChat({
      id,
      userId: session.user.id,
      title,
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

  // 6) Call your n8n webhook (no AI Gateway)
  const webhookUrl = process.env.N8N_WEBHOOK_URL;
  if (!webhookUrl) {
    console.error("Missing N8N_WEBHOOK_URL");
    return new ChatSDKError("offline:chat").toResponse();
  }

  let res: Response | null = null;
  try {
    res = await fetch(webhookUrl, {
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
  } catch (err) {
    console.error("Failed to reach n8n webhook:", err);
  }

  if (!res) return new ChatSDKError("offline:chat").toResponse();

  // 7) Stream n8n response back to UI
  const msgId = generateUUID();

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      try {
        if (!res!.body) {
          const text = await res!.text();
          writer.write({ type: "text-delta", delta: text, id: msgId });
          finishWriter(writer);
          return;
        }

        const reader = res!.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          writer.write({
            type: "text-delta",
            delta: decoder.decode(value),
            id: msgId,
          });
        }

        finishWriter(writer);
      } catch (e) {
        console.error("Proxy stream error", e);
        writer.write({
          type: "text-delta",
          delta: "There was an error connecting to the assistant.",
          id: msgId,
        });
        finishWriter(writer);
      }
    },
    generateId: generateUUID,
    onFinish: async ({ messages }) => {
      await saveMessages({
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          parts: m.parts,
          createdAt: new Date(),
          attachments: [],
          chatId: id,
        })),
      });
    },
    onError: () => "Oops, an error occurred!",
  });

  return new Response(stream.pipeThrough(new JsonToSseTransformStream()));
}
